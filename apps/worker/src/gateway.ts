import {
  envelope,
  ERROR_TEXT,
  parseClientMessage,
  SUPPORTED_VERSIONS,
  type ClientMessage,
  type ClientMessageOf,
  type ErrorCode,
  type HostMetrics,
  type ModelInfo,
  type ModelMetrics,
  type WorkerDraft,
} from "@relayllm/protocol";
import { ProviderError, type ChatRequest, type ProviderAdapter, type ProviderModel } from "@relayllm/provider-adapters";
import { hexToNpub, type IncomingMessage } from "@relayllm/nostr-transport";
import { addPending, authorize, DailyQuota, RateLimiter, redeemInvite, type Authorization } from "./access.ts";
import type { Config } from "./config.ts";
import { sampleHost, type HostSampler } from "./host-metrics.ts";
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
  /** Machine stats source (injectable for tests). Only called on request, never polled. */
  hostSampler?: HostSampler;
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
  /** Metrics requests have their own budget so an open panel never eats into chat limits. */
  readonly #metricsLimiter = new RateLimiter(30, 10);
  readonly #modelInfoCache = new Map<string, { at: number; value: Promise<ModelMetrics | null> }>();
  #hostCache: { at: number; value: Promise<HostMetrics | null> } | null = null;

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

    if (m.type === "metrics.get") {
      // Explicitly authorized users only (not anonymous public-mode users).
      if (auth !== "user") return this.#error(replyTo, "unauthorized", m.id);
      const wait = this.#metricsLimiter.take(msg.sender, this.#now());
      if (wait > 0) return this.#error(replyTo, "rate_limited", m.id, { retryAfter: wait });
      return this.#metrics(replyTo, m);
    }

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
            maxSystemPromptChars: cfg.limits.maxSystemPromptChars,
          },
        });
      case "models.list":
        return this.#reply(replyTo, { type: "models.list.result", re: m.id, models: await this.exposedModels() });
      case "chat.start":
        return this.#chat(msg.sender, replyTo, m);
    }
  }

  async #metrics(replyTo: string, m: ClientMessageOf<"metrics.get">): Promise<void> {
    const cfg = this.#d.getConfig();
    if (m.model && !cfg.models.exposed.includes(m.model)) return this.#error(replyTo, "model_unavailable", m.id);
    const [model, engine, host] = await Promise.all([
      m.model ? this.modelMetrics(m.model) : null,
      cfg.monitoring.engineMetrics ? this.#engineMetrics() : null,
      m.host && cfg.monitoring.host ? this.#hostMetrics(cfg.monitoring.intervalSec) : null,
    ]);
    return this.#reply(replyTo, {
      type: "metrics.result",
      re: m.id,
      at: this.#now(),
      provider: cfg.provider.kind,
      model,
      engine,
      host,
      monitoring: { host: cfg.monitoring.host, refreshSec: cfg.monitoring.intervalSec },
    });
  }

  /** Model metadata, cached briefly (load state can change with JIT loading). */
  modelMetrics(id: string): Promise<ModelMetrics | null> {
    const now = this.#now();
    const hit = this.#modelInfoCache.get(id);
    if (hit && now - hit.at < 3000) return hit.value;
    const value = this.#d.provider.modelInfo(id).then(
      (i): ModelMetrics => ({
        id,
        at: this.#now(),
        state: i.state,
        maxContext: i.maxContext ?? null,
        loadedContext: i.loadedContext ?? null,
        memoryBytes: i.memoryBytes ?? null,
        vramBytes: i.vramBytes ?? null,
        sizeBytes: i.sizeBytes ?? null,
        architecture: i.architecture ?? null,
        quantization: i.quantization ?? null,
        parameters: i.parameters ?? null,
      }),
      (e) => {
        this.#d.log.debug("model metrics unavailable", { model: id, error: (e as Error).message });
        return null;
      },
    );
    if (this.#modelInfoCache.size > 200) this.#modelInfoCache.clear();
    this.#modelInfoCache.set(id, { at: now, value });
    return value;
  }

  async #engineMetrics() {
    try {
      const s = await this.#d.provider.engineStats();
      if (!s) return null;
      return {
        at: this.#now(),
        kvCacheUsage: s.kvCacheUsage ?? null,
        requestsRunning: s.requestsRunning ?? null,
        requestsWaiting: s.requestsWaiting ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Sampled only when an authorized client asks; reused within half the refresh interval. */
  #hostMetrics(intervalSec: number): Promise<HostMetrics | null> {
    const now = this.#now();
    if (this.#hostCache && now - this.#hostCache.at < (intervalSec * 1000) / 2) return this.#hostCache.value;
    const value = (this.#d.hostSampler ?? sampleHost)().catch((e) => {
      this.#d.log.debug("host metrics failed", { error: (e as Error).message });
      return null;
    });
    this.#hostCache = { at: now, value };
    return value;
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
      this.#d.log.info(`access requested — approve with: relayllm users approve ${hexToNpub(sender)}`, { label: m.label });
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
    // System instructions are plain text for the model, nothing more: they may
    // only lead the conversation, are size-capped, and never touch access,
    // provider, or limit settings (all of which come from this worker's config).
    const firstNonSystem = m.messages.findIndex((x) => x.role !== "system");
    if (firstNonSystem === -1 || m.messages.slice(firstNonSystem).some((x) => x.role === "system")) {
      return this.#error(replyTo, "invalid_request", m.id, { message: "System instructions must come first, before the conversation." });
    }
    const systemChars = m.messages.slice(0, firstNonSystem).reduce((n, x) => n + x.content.length, 0);
    if (systemChars > cfg.limits.maxSystemPromptChars) {
      return this.#error(replyTo, "too_large", m.id, { message: "The system prompt is longer than this worker allows." });
    }

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
      systemPromptStyle: cfg.models.systemPromptStyle[m.model] ?? cfg.provider.systemPromptStyle,
    };

    let finishReason: "stop" | "length" | "cancelled" | "error" | "timeout" = "stop";
    let errorCode: ErrorCode | undefined;
    let usage: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number } | undefined;
    const startedAt = this.#now();
    let firstTokenAt: number | undefined;
    try {
      for await (const chunk of this.#d.provider.chat(req, s.controller.signal)) {
        if (chunk.type === "done") {
          finishReason = chunk.finishReason === "error" ? "error" : chunk.finishReason;
          usage = chunk.usage;
          break;
        }
        firstTokenAt ??= this.#now();
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
    const finalUsage = completeUsage(usage, m.messages, s.totalChars, startedAt, firstTokenAt, this.#now());

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
      usage: finalUsage,
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

/** Rough token estimate for text when the engine reports no usage (~4 chars/token). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * Token counts for chat.complete: the engine's when it reports them
 * ("measured"), otherwise estimated from text length ("estimated"), plus
 * timing measured by the worker around the engine stream.
 */
export function completeUsage(
  reported: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number } | undefined,
  messages: readonly { content: string }[],
  outputChars: number,
  startedAt: number,
  firstTokenAt: number | undefined,
  endedAt: number,
) {
  const measured = reported?.promptTokens !== undefined && reported?.completionTokens !== undefined;
  const promptTokens = reported?.promptTokens ?? messages.reduce((n, x) => n + 4 + estimateTokens(x.content.length), 0);
  const completionTokens = reported?.completionTokens ?? estimateTokens(outputChars);
  const generationMs = firstTokenAt !== undefined ? Math.max(0, endedAt - firstTokenAt) : undefined;
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: reported?.reasoningTokens,
    source: measured ? ("measured" as const) : ("estimated" as const),
    firstTokenMs: firstTokenAt !== undefined ? Math.max(0, firstTokenAt - startedAt) : undefined,
    generationMs,
    tokensPerSecond:
      generationMs !== undefined && generationMs >= 50 && completionTokens > 0
        ? Math.round((completionTokens / (generationMs / 1000)) * 10) / 10
        : undefined,
  };
}

function replyToOf(payload: unknown): string | undefined {
  const r = (payload as { replyTo?: unknown } | null)?.replyTo;
  return typeof r === "string" && /^[0-9a-f]{64}$/.test(r) ? r : undefined;
}

export type { ClientMessage };
