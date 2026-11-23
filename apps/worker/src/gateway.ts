import {
  envelope,
  ERROR_TEXT,
  parseClientMessage,
  SUPPORTED_VERSIONS,
  type ClientMessage,
  type ClientMessageOf,
  type ErrorCode,
  type ModelInfo,
  type WorkerDraft,
} from "@relayllm/protocol";
import { ProviderError, type ChatRequest, type ProviderAdapter, type ProviderModel } from "@relayllm/provider-adapters";
import type { IncomingMessage } from "@relayllm/nostr-transport";
import { addPending, authorize, DailyQuota, RateLimiter, redeemInvite, type Authorization } from "./access.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";

export const SOFTWARE = "relayllm-worker/0.1.0";

export interface GatewayDeps {
  getConfig: () => Config;
  /** Apply and persist a config mutation (access list changes). */
  mutateConfig: (fn: (cfg: Config) => void) => Config;
  provider: ProviderAdapter;
  /** Publish an encrypted message. Rejects if no relay accepted it. */
  send: (recipient: string, message: object) => Promise<unknown>;
  log: Logger;
  now?: () => number;
}

interface StreamDelta {
  seq: number;
  content?: string;
  reasoning?: string;
}

interface ActiveStream {
  id: string;
  sender: string;
  replyTo: string;
  model: string;
  controller: AbortController;
  deltas: StreamDelta[];
  contentLength: number;
  totalChars: number;
  pendingContent: string;
  pendingReasoning: string;
  lastFlush: number;
  inFlight: Promise<void> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  done: boolean;
  completion?: WorkerDraft;
  cancelReason?: "cancelled" | "timeout" | "length";
  lastResumeAt: number;
  expireTimer?: ReturnType<typeof setTimeout>;
}

const short = (pk: string) => `${pk.slice(0, 8)}…`;

export class Gateway {
  readonly #d: GatewayDeps;
  readonly #streams = new Map<string, ActiveStream>();
  readonly #userLimiter: RateLimiter;
  readonly #publicLimiter: RateLimiter;
  readonly #publicQuota = new DailyQuota();
  /** Limits replies to unauthorized senders (anti-amplification). */
  readonly #deniedLimiter = new RateLimiter(3, 3);
  readonly #deniedGlobal = new RateLimiter(60, 30);
  readonly #pairLimiter = new RateLimiter(5, 5);
  #modelCache: { at: number; models: ProviderModel[] | null } = { at: 0, models: null };

  constructor(deps: GatewayDeps) {
    this.#d = deps;
    const cfg = deps.getConfig();
    this.#userLimiter = new RateLimiter(cfg.limits.requestsPerMinute);
    this.#publicLimiter = new RateLimiter(cfg.limits.publicRequestsPerMinute);
  }

  get activeCount(): number {
    let n = 0;
    for (const s of this.#streams.values()) if (!s.done) n++;
    return n;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  async #reply(to: string, draft: WorkerDraft): Promise<void> {
    try {
      await this.#d.send(to, envelope(draft));
    } catch (e) {
      this.#d.log.warn("publish failed", { type: draft.type, error: (e as Error).message });
    }
  }

  #error(to: string, code: ErrorCode, re?: string, extra: { retryAfter?: number; message?: string } = {}): Promise<void> {
    return this.#reply(to, {
      type: "server.error",
      re,
      code,
      message: extra.message ?? ERROR_TEXT[code],
      retryAfter: extra.retryAfter,
      versions: code === "unsupported_version" ? [...SUPPORTED_VERSIONS] : undefined,
    });
  }

  /** Entry point for every authenticated, decrypted incoming message. */
  async handle(msg: IncomingMessage): Promise<void> {
    const cfg = this.#d.getConfig();
    const auth = authorize(cfg, msg.sender);
    const parsed = parseClientMessage(msg.payload, Math.floor(this.#now() / 1000));

    if (!parsed.ok) {
      // Only tell known users why; strangers get silence (pairing aside).
      this.#d.log.debug("rejected message", { sender: short(msg.sender), reason: parsed.reason });
      if (auth === "user" && parsed.code !== "expired") {
        const replyTo = replyToOf(msg.payload) ?? msg.sender;
        await this.#error(replyTo, parsed.code, parsed.id);
      }
      return;
    }
    const m = parsed.message;
    const replyTo = m.replyTo ?? msg.sender;

    if (m.type === "pair.request") return this.#pair(msg.sender, replyTo, m, auth);

    if (auth === "denied") {
      this.#d.log.info("unauthorized request", { sender: short(msg.sender), type: m.type });
      const now = this.#now();
      if (this.#deniedLimiter.take(msg.sender, now) === 0 && this.#deniedGlobal.take("*", now) === 0) {
        const pending = cfg.access.pending.some((p) => p.pubkey === msg.sender);
        await this.#error(replyTo, pending ? "pending_approval" : "unauthorized", m.id);
      }
      return;
    }

    if (msg.size > cfg.limits.maxRequestBytes) return this.#error(replyTo, "too_large", m.id);

    switch (m.type) {
      case "chat.cancel":
        return this.#cancel(msg.sender, m);
      case "chat.resume":
        return this.#resume(msg.sender, m);
    }

    // Rate limit request-generating operations.
    const limiter = auth === "public" ? this.#publicLimiter : this.#userLimiter;
    limiter.setRate(auth === "public" ? cfg.limits.publicRequestsPerMinute : cfg.limits.requestsPerMinute);
    const wait = limiter.take(msg.sender, this.#now());
    if (wait > 0) return this.#error(replyTo, "rate_limited", m.id, { retryAfter: wait });
    if (auth === "public" && m.type === "chat.start" && !this.#publicQuota.take(msg.sender, cfg.limits.publicRequestsPerDay)) {
      return this.#error(replyTo, "rate_limited", m.id, { retryAfter: 3600 });
    }

    switch (m.type) {
      case "server.info":
        return this.#reply(replyTo, {
          type: "server.info.result",
          re: m.id,
          name: cfg.name,
          software: SOFTWARE,
          versions: [...SUPPORTED_VERSIONS],
          streaming: { batchMs: cfg.streaming.batchMs, resume: true },
          limits: {
            maxRequestBytes: cfg.limits.maxRequestBytes,
            maxResponseChars: cfg.limits.maxResponseChars,
            maxMessages: cfg.limits.maxMessages,
            requestTimeoutSec: cfg.limits.requestTimeoutSec,
          },
        });
      case "models.list":
        return this.#reply(replyTo, { type: "models.list.result", re: m.id, models: await this.exposedModels() });
      case "chat.start":
        return this.#chat(msg.sender, replyTo, m);
    }
  }

  async #pair(sender: string, replyTo: string, m: ClientMessageOf<"pair.request">, auth: Authorization): Promise<void> {
    if (this.#pairLimiter.take(sender, this.#now()) > 0 || this.#deniedGlobal.take("pair", this.#now()) > 0) return;
    if (auth === "user" || auth === "public") {
      return this.#reply(replyTo, { type: "pair.result", re: m.id, status: "approved" });
    }
    let approved = false;
    if (m.token) {
      this.#d.mutateConfig((cfg) => {
        approved = redeemInvite(cfg, m.token!, sender, m.label);
      });
    }
    if (approved) {
      this.#d.log.info("user paired via invite", { user: short(sender) });
      return this.#reply(replyTo, { type: "pair.result", re: m.id, status: "approved" });
    }
    let added = false;
    this.#d.mutateConfig((cfg) => {
      added = addPending(cfg, sender, m.label);
    });
    if (added) {
      this.#d.log.info("access requested — approve with: relayllm users approve <npub>", { user: short(sender) });
    }
    return this.#reply(replyTo, { type: "pair.result", re: m.id, status: "pending" });
  }

  /** Models visible to authorized clients: configured allowlist ∩ (discovered ∪ manual). */
  async exposedModels(): Promise<ModelInfo[]> {
    const cfg = this.#d.getConfig();
    const now = this.#now();
    if (!this.#modelCache.models || now - this.#modelCache.at > 60_000) {
      try {
        this.#modelCache = { at: now, models: await this.#d.provider.listModels() };
      } catch {
        this.#modelCache = { at: now, models: null };
      }
    }
    const discovered = new Map((this.#modelCache.models ?? []).map((m) => [m.id, m]));
    const caps = this.#d.provider.capabilities;
    return cfg.models.exposed
      .filter((id) => discovered.has(id) || cfg.models.manual.includes(id) || this.#modelCache.models === null)
      .map((id) => ({
        id,
        contextLength: discovered.get(id)?.contextLength,
        streaming: caps.streaming,
        cancel: caps.cancel,
      }));
  }

  async #chat(sender: string, replyTo: string, m: ClientMessageOf<"chat.start">): Promise<void> {
    const cfg = this.#d.getConfig();
    const existing = this.#streams.get(m.id);
    if (existing) {
      // Duplicate start (client retry): acknowledge again, don't re-run.
      if (existing.sender === sender) await this.#reply(existing.replyTo, { type: "chat.ack", re: m.id, model: existing.model });
      return;
    }
    if (m.messages.length > cfg.limits.maxMessages) return this.#error(replyTo, "too_large", m.id, { message: "Too many messages in conversation." });
    if (!cfg.models.exposed.includes(m.model)) return this.#error(replyTo, "model_unavailable", m.id);

    const active = [...this.#streams.values()].filter((s) => !s.done);
    if (active.length >= cfg.limits.maxConcurrent) return this.#error(replyTo, "busy", m.id, { retryAfter: 5 });
    if (active.filter((s) => s.sender === sender).length >= cfg.limits.perUserConcurrent) {
      return this.#error(replyTo, "busy", m.id, { retryAfter: 2, message: "You already have a response in progress." });
    }

    const s: ActiveStream = {
      id: m.id,
      sender,
      replyTo,
      model: m.model,
      controller: new AbortController(),
      deltas: [],
      contentLength: 0,
      totalChars: 0,
      pendingContent: "",
      pendingReasoning: "",
      lastFlush: this.#now(),
      inFlight: null,
      flushTimer: null,
      done: false,
      lastResumeAt: 0,
    };
    this.#streams.set(m.id, s);
    this.#d.log.info("chat started", { req: m.id.slice(0, 8), user: short(sender), model: m.model, messages: m.messages.length });

    const timeout = setTimeout(() => {
      s.cancelReason = "timeout";
      s.controller.abort();
    }, cfg.limits.requestTimeoutSec * 1000);

    await this.#reply(replyTo, { type: "chat.ack", re: m.id, model: m.model });

    const req: ChatRequest = {
      model: m.model,
      messages: m.messages,
      temperature: m.params?.temperature,
      top_p: m.params?.top_p,
      max_tokens: Math.min(m.params?.max_tokens ?? cfg.limits.maxTokens, cfg.limits.maxTokens),
    };

    let finishReason: "stop" | "length" | "cancelled" | "error" | "timeout" = "stop";
    let errorCode: ErrorCode | undefined;
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    try {
      for await (const chunk of this.#d.provider.chat(req, s.controller.signal)) {
        if (chunk.type === "done") {
          finishReason = chunk.finishReason === "error" ? "error" : chunk.finishReason;
          usage = chunk.usage;
          break;
        }
        if (chunk.type === "content") {
          s.pendingContent += chunk.text;
          s.contentLength += chunk.text.length;
        } else {
          s.pendingReasoning += chunk.text;
        }
        s.totalChars += chunk.text.length;
        if (s.totalChars > cfg.limits.maxResponseChars) {
          s.cancelReason = "length";
          s.controller.abort();
          break;
        }
        this.#maybeFlush(s, cfg);
      }
    } catch (e) {
      if (s.cancelReason) {
        /* handled below */
      } else if (e instanceof ProviderError) {
        finishReason = "error";
        errorCode = e.code === "unavailable" ? "provider_unavailable" : "provider_error";
        this.#d.log.warn("provider error", { req: m.id.slice(0, 8), error: e.message });
      } else {
        finishReason = "error";
        errorCode = "internal";
        this.#d.log.error("chat failed", { req: m.id.slice(0, 8), error: (e as Error).message });
      }
    } finally {
      clearTimeout(timeout);
    }
    if (s.cancelReason) {
      finishReason = s.cancelReason === "length" ? "length" : s.cancelReason;
      if (s.cancelReason === "timeout") errorCode = "timeout";
    }

    // Final flush, then completion.
    while (s.inFlight || s.pendingContent || s.pendingReasoning) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      s.flushTimer = null;
      if (s.inFlight) await s.inFlight;
      else await this.#flush(s);
    }
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = null;
    s.done = true;
    s.completion = {
      type: "chat.complete",
      re: s.id,
      deltaCount: s.deltas.length,
      finishReason,
      errorCode,
      contentLength: s.contentLength,
      usage,
    };
    await this.#reply(s.replyTo, s.completion);
    this.#d.log.info("chat finished", { req: m.id.slice(0, 8), finishReason, deltas: s.deltas.length, chars: s.totalChars });
    // Keep the transcript briefly so clients can recover lost chunks.
    s.expireTimer = setTimeout(() => this.#streams.delete(s.id), cfg.streaming.resumeBufferSec * 1000);
    s.expireTimer.unref?.();
  }

  /** Batch by time or size; at most one publish in flight per stream. */
  #maybeFlush(s: ActiveStream, cfg: Config): void {
    if (s.inFlight) return; // backpressure: text keeps coalescing
    const pending = s.pendingContent.length + s.pendingReasoning.length;
    if (pending === 0) return;
    const elapsed = this.#now() - s.lastFlush;
    if (elapsed >= cfg.streaming.batchMs || pending >= cfg.streaming.maxBatchChars) {
      void this.#flush(s);
    } else if (!s.flushTimer) {
      s.flushTimer = setTimeout(() => {
        s.flushTimer = null;
        if (!s.done) this.#maybeFlush(s, cfg);
      }, cfg.streaming.batchMs - elapsed);
    }
  }

  #flush(s: ActiveStream): Promise<void> {
    const cfg = this.#d.getConfig();
    // Never exceed maxBatchChars per event, even after a backlog.
    const max = cfg.streaming.maxBatchChars;
    const reasoning = s.pendingReasoning.slice(0, max);
    s.pendingReasoning = s.pendingReasoning.slice(reasoning.length);
    const content = s.pendingContent.slice(0, max - reasoning.length);
    s.pendingContent = s.pendingContent.slice(content.length);
    const delta: StreamDelta = { seq: s.deltas.length };
    if (content) delta.content = content;
    if (reasoning) delta.reasoning = reasoning;
    s.deltas.push(delta);
    s.lastFlush = this.#now();
    const p = this.#reply(s.replyTo, { type: "chat.delta", re: s.id, ...delta }).then(async () => {
      s.inFlight = null;
      if (s.pendingContent.length + s.pendingReasoning.length >= max) await this.#flush(s);
      else if (!s.done) this.#maybeFlush(s, cfg);
    });
    s.inFlight = p;
    return p;
  }

  async #cancel(sender: string, m: ClientMessageOf<"chat.cancel">): Promise<void> {
    const s = this.#streams.get(m.target);
    if (!s || s.sender !== sender) return; // don't reveal other users' requests
    if (!s.done && !s.cancelReason) {
      s.cancelReason = "cancelled";
      s.controller.abort();
      this.#d.log.info("chat cancelled", { req: m.target.slice(0, 8) });
    }
  }

  async #resume(sender: string, m: ClientMessageOf<"chat.resume">): Promise<void> {
    const s = this.#streams.get(m.target);
    const replyTo = m.replyTo ?? sender;
    if (!s || s.sender !== sender) return this.#error(replyTo, "not_found", m.id);
    const now = this.#now();
    if (now - s.lastResumeAt < 1000) return;
    s.lastResumeAt = now;
    // Responses go to the key named in this (authenticated) resume, so a
    // client that reconnected with a new session key can recover.
    s.replyTo = replyTo;
    const wanted = m.missing
      ? s.deltas.filter((d) => m.missing!.includes(d.seq))
      : s.deltas.filter((d) => d.seq >= (m.fromSeq ?? 0));
    for (const d of wanted.slice(0, 200)) await this.#reply(replyTo, { type: "chat.delta", re: s.id, ...d });
    if (s.done && s.completion) await this.#reply(replyTo, s.completion);
  }

  /** Abort everything (shutdown). */
  shutdown(): void {
    for (const s of this.#streams.values()) {
      if (!s.done) {
        s.cancelReason = "cancelled";
        s.controller.abort();
      }
      if (s.expireTimer) clearTimeout(s.expireTimer);
      if (s.flushTimer) clearTimeout(s.flushTimer);
    }
  }
}

function replyToOf(payload: unknown): string | undefined {
  const r = (payload as { replyTo?: unknown } | null)?.replyTo;
  return typeof r === "string" && /^[0-9a-f]{64}$/.test(r) ? r : undefined;
}

export type { ClientMessage };
