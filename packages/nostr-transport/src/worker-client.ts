import { generateSecretKey } from "nostr-tools/pure";
import {
  envelope,
  ERROR_TEXT,
  parseWorkerMessage,
  type ChatMessage,
  type ChatParams,
  type ClientDraft,
  type ErrorCode,
  type ModelInfo,
  type WorkerMessage,
  type WorkerMessageOf,
} from "@relayllm/protocol";
import { NostrEndpoint } from "./endpoint.ts";
import type { RelayPool } from "./relay-pool.ts";
import { LocalSigner, type Signer } from "./signer.ts";

export class RemoteError extends Error {
  constructor(
    readonly code: ErrorCode | "no_response" | "publish_failed",
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/**
 * Reorders, de-duplicates and gap-detects streamed chat deltas.
 */
export class StreamAssembler {
  readonly #chunks = new Map<number, { content?: string; reasoning?: string }>();
  #next = 0;
  content = "";
  reasoning = "";

  /** Returns true if this delta advanced the in-order output. */
  add(seq: number, content?: string, reasoning?: string): boolean {
    if (seq < this.#next || this.#chunks.has(seq)) return false; // duplicate
    if (seq > this.#next + 10_000) return false; // absurd gap, ignore
    this.#chunks.set(seq, { content, reasoning });
    let advanced = false;
    for (;;) {
      const c = this.#chunks.get(this.#next);
      if (!c) break;
      this.#chunks.delete(this.#next);
      if (c.content) this.content += c.content;
      if (c.reasoning) this.reasoning += c.reasoning;
      this.#next++;
      advanced = true;
    }
    return advanced;
  }

  /** Next sequence number expected in order. */
  get nextSeq(): number {
    return this.#next;
  }

  /** Sequence numbers missing below `upTo` (exclusive). */
  missing(upTo: number): number[] {
    const out: number[] = [];
    for (let i = this.#next; i < upTo && out.length < 1000; i++) if (!this.#chunks.has(i)) out.push(i);
    return out;
  }

  get hasGap(): boolean {
    return this.#chunks.size > 0;
  }

  /** One past the highest sequence number seen so far. */
  get seenUpTo(): number {
    let max = this.#next;
    for (const k of this.#chunks.keys()) if (k + 1 > max) max = k + 1;
    return max;
  }
}

export interface ChatCallbacks {
  onAck?: () => void;
  onUpdate?: (state: { content: string; reasoning: string }) => void;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  finishReason: WorkerMessageOf<"chat.complete">["finishReason"];
  errorCode?: ErrorCode;
  usage?: WorkerMessageOf<"chat.complete">["usage"];
  /** True if chunks were still missing when we gave up on recovery. */
  incomplete: boolean;
}

export interface ChatHandle {
  id: string;
  cancel(): Promise<void>;
  result: Promise<ChatResult>;
}

interface PendingRequest {
  resolve: (m: WorkerMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveChat {
  id: string;
  asm: StreamAssembler;
  callbacks: ChatCallbacks;
  complete?: WorkerMessageOf<"chat.complete">;
  resolve: (r: ChatResult) => void;
  reject: (e: Error) => void;
  startedAt: number;
  acked: boolean;
  startResent: boolean;
  startMsg: object;
  lastEventAt: number;
  gapAttempts: number;
  gapSince: number | null;
  watchdog: ReturnType<typeof setInterval>;
  deadline: number;
}

export interface WorkerClientOptions {
  pool: RelayPool;
  /** Long-term user identity: signs requests (local key or NIP-07). */
  identity: Signer;
  workerPubkey: string;
  /** Per-session key for receiving responses. Generated if omitted. */
  session?: Signer;
  requestTimeoutMs?: number;
  /** Max time to wait for a chat to complete. */
  chatTimeoutMs?: number;
  /** Gap/stall duration before asking the worker to re-send. */
  resumeAfterMs?: number;
}

/**
 * Client side of the RelayLLM protocol for one worker.
 */
export class WorkerClient {
  readonly #o: Required<Omit<WorkerClientOptions, "session">> & { session: Signer };
  readonly #endpoint: NostrEndpoint;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #chats = new Map<string, ActiveChat>();
  #wasConnected = false;

  constructor(opts: WorkerClientOptions) {
    this.#o = {
      requestTimeoutMs: 15_000,
      chatTimeoutMs: 330_000,
      resumeAfterMs: 2500,
      ...opts,
      session: opts.session ?? new LocalSigner(generateSecretKey()),
    };
    this.#endpoint = new NostrEndpoint({
      pool: opts.pool,
      signer: this.#o.identity,
      receivers: [this.#o.session],
      onMessage: (m) => {
        if (m.sender !== this.#o.workerPubkey) return; // only our worker
        const parsed = parseWorkerMessage(m.payload);
        if (parsed.ok) this.#onMessage(parsed.message);
      },
    });
  }

  get pool(): RelayPool {
    return this.#o.pool;
  }

  get sessionPubkey(): string {
    return this.#o.session.pubkey;
  }

  get workerPubkey(): string {
    return this.#o.workerPubkey;
  }

  start(): void {
    this.#endpoint.start();
  }

  stop(): void {
    this.#endpoint.stop();
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RemoteError("no_response", "Client stopped"));
    }
    this.#pending.clear();
    for (const c of this.#chats.values()) {
      clearInterval(c.watchdog);
      c.reject(new RemoteError("no_response", "Client stopped"));
    }
    this.#chats.clear();
  }

  /** Call when relay connectivity changes; resumes in-flight streams. */
  onConnectivity(connected: boolean): void {
    if (connected && !this.#wasConnected) {
      for (const c of this.#chats.values()) void this.#resume(c, c.asm.nextSeq);
    }
    this.#wasConnected = connected;
  }

  async #send(draft: ClientDraft, ttlSec = 120): Promise<string> {
    const msg = envelope({ ...draft, replyTo: this.#o.session.pubkey } as ClientDraft, { ttlSec });
    try {
      await this.#endpoint.send(this.#o.workerPubkey, msg);
    } catch (e) {
      throw new RemoteError("publish_failed", `Could not reach any relay: ${(e as Error).message}`);
    }
    return msg.id;
  }

  async #request<T extends WorkerMessage["type"]>(draft: ClientDraft, expect: T): Promise<WorkerMessageOf<T>> {
    const msg = envelope({ ...draft, replyTo: this.#o.session.pubkey } as ClientDraft);
    const result = new Promise<WorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(msg.id);
        reject(new RemoteError("no_response", "The worker did not respond. It may be offline or unreachable via these relays."));
      }, this.#o.requestTimeoutMs);
      this.#pending.set(msg.id, { resolve, reject, timer });
    });
    try {
      await this.#endpoint.send(this.#o.workerPubkey, msg);
    } catch (e) {
      const p = this.#pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.#pending.delete(msg.id);
      }
      throw new RemoteError("publish_failed", `Could not reach any relay: ${(e as Error).message}`);
    }
    const res = await result;
    if (res.type === "server.error") throw new RemoteError(res.code, res.message || ERROR_TEXT[res.code], res.retryAfter);
    if (res.type !== expect) throw new RemoteError("internal", `Unexpected response ${res.type}`);
    return res as WorkerMessageOf<T>;
  }

  serverInfo() {
    return this.#request({ type: "server.info" }, "server.info.result");
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.#request({ type: "models.list" }, "models.list.result")).models;
  }

  async pair(token?: string, label?: string): Promise<"approved" | "pending" | "denied"> {
    return (await this.#request({ type: "pair.request", token, label }, "pair.result")).status;
  }

  chat(req: { model: string; messages: ChatMessage[]; params?: ChatParams }, callbacks: ChatCallbacks = {}): ChatHandle {
    const draft: ClientDraft = { type: "chat.start", model: req.model, messages: req.messages, params: req.params };
    const msg = envelope({ ...draft, replyTo: this.#o.session.pubkey } as ClientDraft);
    const id = msg.id;
    const result = new Promise<ChatResult>((resolve, reject) => {
      const chat: ActiveChat = {
        id,
        asm: new StreamAssembler(),
        callbacks,
        resolve,
        reject,
        startedAt: Date.now(),
        acked: false,
        startResent: false,
        startMsg: msg,
        lastEventAt: Date.now(),
        gapAttempts: 0,
        gapSince: null,
        deadline: Date.now() + this.#o.chatTimeoutMs,
        watchdog: setInterval(() => this.#watch(chat), 500),
      };
      this.#chats.set(id, chat);
    });
    void this.#endpoint.send(this.#o.workerPubkey, msg).catch((e) => {
      this.#finishWithError(id, new RemoteError("publish_failed", `Could not reach any relay: ${(e as Error).message}`));
    });
    return {
      id,
      result,
      cancel: async () => {
        if (!this.#chats.has(id)) return;
        await this.#send({ type: "chat.cancel", target: id }).catch(() => undefined);
      },
    };
  }

  #finishWithError(id: string, err: Error): void {
    const c = this.#chats.get(id);
    if (!c) return;
    clearInterval(c.watchdog);
    this.#chats.delete(id);
    c.reject(err);
  }

  #watch(c: ActiveChat): void {
    const now = Date.now();
    if (now > c.deadline) {
      this.#finishWithError(c.id, new RemoteError("timeout", "Timed out waiting for the response."));
      return;
    }
    if (!c.acked) {
      if (!c.startResent && now - c.startedAt > this.#o.resumeAfterMs * 2) {
        // Ephemeral events can be lost; the worker de-duplicates by id.
        c.startResent = true;
        void this.#endpoint.send(this.#o.workerPubkey, c.startMsg).catch(() => undefined);
      }
      if (now - c.startedAt > this.#o.requestTimeoutMs) {
        this.#finishWithError(
          c.id,
          new RemoteError("no_response", "The worker did not respond. It may be offline or unreachable via these relays."),
        );
      }
      return;
    }
    const gapStuck = c.gapSince !== null && now - c.gapSince > this.#o.resumeAfterMs;
    if (gapStuck) {
      if (c.gapAttempts >= 8) {
        if (c.complete) this.#finalize(c, true);
        return;
      }
      c.gapAttempts++;
      c.gapSince = now;
      const upTo = c.complete ? c.complete.deltaCount : c.asm.seenUpTo;
      const missing = c.asm.missing(upTo);
      void this.#resume(c, missing.length ? undefined : c.asm.nextSeq, missing.length ? missing : undefined);
      return;
    }
    if (!c.complete && now - c.lastEventAt > Math.max(this.#o.resumeAfterMs * 6, 15_000)) {
      // Stalled: maybe we missed the tail of the stream. Cheap probe.
      c.lastEventAt = now;
      void this.#resume(c, c.asm.nextSeq);
    }
  }

  async #resume(c: ActiveChat, fromSeq?: number, missing?: number[]): Promise<void> {
    await this.#send(missing ? { type: "chat.resume", target: c.id, missing } : { type: "chat.resume", target: c.id, fromSeq: fromSeq ?? 0 }).catch(
      () => undefined,
    );
  }

  #finalize(c: ActiveChat, incomplete = false): void {
    const done = c.complete!;
    clearInterval(c.watchdog);
    this.#chats.delete(c.id);
    c.resolve({
      content: c.asm.content,
      reasoning: c.asm.reasoning,
      finishReason: done.finishReason,
      errorCode: done.errorCode,
      usage: done.usage,
      // Integrity: the reassembled text must match what the worker generated.
      incomplete: incomplete || c.asm.content.length !== done.contentLength,
    });
  }

  #onMessage(m: WorkerMessage): void {
    if (m.type === "chat.ack" || m.type === "chat.delta" || m.type === "chat.complete") {
      const c = this.#chats.get(m.re);
      if (!c) return;
      c.lastEventAt = Date.now();
      c.acked = true;
      if (m.type === "chat.ack") {
        c.callbacks.onAck?.();
        return;
      }
      if (m.type === "chat.delta") {
        if (c.asm.add(m.seq, m.content, m.reasoning)) {
          c.callbacks.onUpdate?.({ content: c.asm.content, reasoning: c.asm.reasoning });
        }
        c.gapSince = c.asm.hasGap ? (c.gapSince ?? Date.now()) : null;
      } else {
        c.complete = m;
      }
      if (c.complete && !c.asm.hasGap && c.asm.nextSeq >= c.complete.deltaCount) this.#finalize(c);
      else if (c.complete && m.type === "chat.complete" && c.gapSince === null) {
        c.gapSince = Date.now() - this.#o.resumeAfterMs - 1; // tail missing: recover on next tick
      }
      return;
    }
    if (m.type === "server.error" && m.re && this.#chats.has(m.re)) {
      this.#finishWithError(m.re, new RemoteError(m.code, m.message || ERROR_TEXT[m.code], m.retryAfter));
      return;
    }
    const re = "re" in m ? m.re : undefined;
    if (!re) return;
    const p = this.#pending.get(re);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(re);
    p.resolve(m);
  }
}
