import { generateSecretKey } from "nostr-tools/pure";
import {
  envelope,
  ERROR_TEXT,
  parseWorkerMessage,
  type ChatMessage,
  type ChatParams,
  type ChatStatus,
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
  /** Worker heartbeat and live statistics. */
  onStatus?: (status: ChatStatus) => void;
}

/**
 * confirmed: the worker stopped the request; finished: it had already ended or
 * isn't running; unconfirmed: the worker didn't (or couldn't) confirm.
 */
export type CancelOutcome = "confirmed" | "finished" | "unconfirmed";

export interface ChatResult {
  content: string;
  reasoning: string;
  finishReason: WorkerMessageOf<"chat.complete">["finishReason"];
  errorCode?: ErrorCode;
  usage?: WorkerMessageOf<"chat.complete">["usage"];
  /** True if chunks were still missing when we gave up on recovery. */
  incomplete: boolean;
  /** Client-side durations (monotonic). */
  timing: { ackMs?: number; totalMs: number };
}

export interface ChatHandle {
  id: string;
  /**
   * Stop now: `result` resolves immediately with the partial text and later
   * chunks are ignored. Resolves once the worker confirms, or can't.
   */
  cancel(): Promise<CancelOutcome>;
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
  ackMs?: number;
  acked: boolean;
  /** Last status number seen; -1 until the worker sends heartbeats. */
  statusN: number;
  /** Last message of any kind from the worker about this chat. */
  lastContactAt: number;
  resumeIds: Set<string>;
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
  /**
   * Safety net for a chat whose worker never reports an end. The worker
   * enforces the real limit; this must be longer.
   */
  chatTimeoutMs?: number;
  /** With relays connected and a worker known to send heartbeats: silence before giving up. */
  lostContactMs?: number;
  /** Wait for a cancellation to be confirmed, per attempt (3 attempts). */
  cancelTimeoutMs?: number;
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
  readonly #cancels = new Map<string, { promise: Promise<CancelOutcome>; resolve: (o: CancelOutcome) => void }>();
  #wasConnected = false;
  #onlineSince = performance.now();

  constructor(opts: WorkerClientOptions) {
    this.#o = {
      requestTimeoutMs: 15_000,
      chatTimeoutMs: 1_890_000,
      lostContactMs: 180_000,
      cancelTimeoutMs: 6000,
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
    for (const c of this.#cancels.values()) c.resolve("unconfirmed");
  }

  /** Call when relay connectivity changes; resumes in-flight streams. */
  onConnectivity(connected: boolean): void {
    if (connected && !this.#wasConnected) {
      this.#onlineSince = performance.now();
      for (const c of this.#chats.values()) if (c.acked) void this.#resume(c, c.asm.nextSeq);
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

  /** Read-only metrics: model metadata, and machine stats if `host` and the owner enabled them. */
  metrics(opts: { model?: string; host?: boolean } = {}) {
    return this.#request({ type: "metrics.get", model: opts.model, host: opts.host }, "metrics.result");
  }

  async pair(token?: string, label?: string): Promise<"approved" | "pending" | "denied"> {
    return (await this.#request({ type: "pair.request", token, label }, "pair.result")).status;
  }

  chat(req: { model: string; messages: ChatMessage[]; params?: ChatParams }, callbacks: ChatCallbacks = {}, opts: { timeoutMs?: number } = {}): ChatHandle {
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
        startedAt: performance.now(),
        acked: false,
        statusN: -1,
        lastContactAt: performance.now(),
        resumeIds: new Set(),
        startResent: false,
        startMsg: msg,
        lastEventAt: performance.now(),
        gapAttempts: 0,
        gapSince: null,
        deadline: performance.now() + (opts.timeoutMs ?? this.#o.chatTimeoutMs),
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
      cancel: () => {
        const c = this.#chats.get(id);
        if (c) {
          clearInterval(c.watchdog);
          this.#chats.delete(id); // later chunks for this id are ignored
          c.resolve({
            content: c.asm.content,
            reasoning: c.asm.reasoning,
            finishReason: "cancelled",
            incomplete: false,
            timing: { ackMs: c.ackMs, totalMs: Math.round(performance.now() - c.startedAt) },
          });
        } else if (!this.#cancels.has(id)) return Promise.resolve("finished");
        return this.cancelRequest(id);
      },
    };
  }

  /** Ask the worker to stop a request by id. Repeat calls share one attempt. */
  cancelRequest(id: string): Promise<CancelOutcome> {
    const existing = this.#cancels.get(id);
    if (existing) return existing.promise;
    let resolve!: (o: CancelOutcome) => void;
    const promise = new Promise<CancelOutcome>((r) => (resolve = r));
    this.#cancels.set(id, { promise, resolve });
    let attempts = 0;
    const attempt = () => {
      if (attempts++ >= 3) return resolve("unconfirmed");
      void this.#send({ type: "chat.cancel", target: id }).catch(() => undefined);
      timer = setTimeout(attempt, this.#o.cancelTimeoutMs);
    };
    let timer: ReturnType<typeof setTimeout>;
    attempt();
    void promise.then(() => {
      clearTimeout(timer);
      // Keep the outcome a little while so repeated Stop presses see it.
      setTimeout(() => this.#cancels.delete(id), 30_000);
    });
    return promise;
  }

  #finishWithError(id: string, err: Error): void {
    const c = this.#chats.get(id);
    if (!c) return;
    clearInterval(c.watchdog);
    this.#chats.delete(id);
    c.reject(err);
  }

  #watch(c: ActiveChat): void {
    const now = performance.now();
    if (now > c.deadline) {
      this.#finishWithError(c.id, new RemoteError("timeout", "The worker never reported the end of this response."));
      void this.cancelRequest(c.id);
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
        void this.cancelRequest(c.id); // in case the request arrives late
      }
      return;
    }
    // Worker silence, with working relays. Inference progress plays no part:
    // a live worker sends heartbeats however long the model thinks.
    const silentFor = now - Math.max(c.lastContactAt, this.#onlineSince);
    if (c.statusN >= 0 && this.#o.pool.connectedCount > 0 && silentFor > this.#o.lostContactMs) {
      this.#finishWithError(c.id, new RemoteError("no_response", "Lost contact with the worker. The text received so far was kept."));
      void this.cancelRequest(c.id);
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
    const draft: ClientDraft = missing ? { type: "chat.resume", target: c.id, missing } : { type: "chat.resume", target: c.id, fromSeq: fromSeq ?? 0 };
    const msg = envelope({ ...draft, replyTo: this.#o.session.pubkey } as ClientDraft);
    c.resumeIds.add(msg.id);
    if (c.resumeIds.size > 50) c.resumeIds.delete(c.resumeIds.values().next().value!);
    await this.#endpoint.send(this.#o.workerPubkey, msg).catch(() => undefined);
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
      timing: { ackMs: c.ackMs, totalMs: Math.round(performance.now() - c.startedAt) },
    });
  }

  #onMessage(m: WorkerMessage): void {
    if (m.type === "chat.cancel.result") {
      this.#cancels.get(m.target)?.resolve(m.status === "cancelled" ? "confirmed" : m.status === "unconfirmed" ? "unconfirmed" : "finished");
      return;
    }
    // A completion also confirms a cancellation (workers without chat.cancel.result).
    if (m.type === "chat.complete") this.#cancels.get(m.re)?.resolve(m.finishReason === "cancelled" ? "confirmed" : "finished");
    if (m.type === "chat.ack" || m.type === "chat.delta" || m.type === "chat.complete" || m.type === "chat.status") {
      const c = this.#chats.get(m.re);
      if (!c) return;
      c.lastEventAt = c.lastContactAt = performance.now();
      c.ackMs ??= Math.round(performance.now() - c.startedAt);
      c.acked = true;
      if (m.type === "chat.status") {
        if (m.n <= c.statusN) return; // late or duplicate
        c.statusN = m.n;
        // The worker has published deltas we haven't seen: recover the tail.
        if (m.deltaCount > c.asm.seenUpTo) c.gapSince ??= performance.now();
        c.callbacks.onStatus?.(m);
        return;
      }
      if (m.type === "chat.ack") {
        c.callbacks.onAck?.();
        return;
      }
      if (m.type === "chat.delta") {
        if (c.asm.add(m.seq, m.content, m.reasoning)) {
          c.gapAttempts = 0; // recovery is making progress
          c.callbacks.onUpdate?.({ content: c.asm.content, reasoning: c.asm.reasoning });
        }
        c.gapSince = c.asm.hasGap ? (c.gapSince ?? performance.now()) : null;
      } else {
        c.complete = m;
      }
      if (c.complete && !c.asm.hasGap && c.asm.nextSeq >= c.complete.deltaCount) this.#finalize(c);
      else if (c.complete && m.type === "chat.complete" && c.gapSince === null) {
        c.gapSince = performance.now() - this.#o.resumeAfterMs - 1; // tail missing: recover on next tick
      }
      return;
    }
    if (m.type === "server.error" && m.re && m.code === "not_found") {
      // The worker no longer knows a chat we tried to resume (it restarted, or we were away too long).
      for (const c of this.#chats.values()) {
        if (!c.resumeIds.has(m.re)) continue;
        if (c.complete) this.#finalize(c, true);
        else this.#finishWithError(c.id, new RemoteError("not_found", "The worker no longer has this request. The text received so far was kept."));
        return;
      }
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
