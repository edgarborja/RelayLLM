import {
  envelope,
  ERROR_TEXT,
  parseClientMessage,
  SUPPORTED_VERSIONS,
  type ClientMessage,
  type ClientMessageOf,
  type CountSource,
  type ErrorCode,
  type FinishDetail,
  type GenerationState,
  type HostMetrics,
  type ModelInfo,
  type ModelMetrics,
  type WorkerDraft,
} from "@relayllm/protocol";
import { type ChatRequest, type InferenceEvent, type ProviderAdapter, type ProviderModel, type ReasoningSetting, type TokenUsage } from "@relayllm/provider-adapters";
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
  /** Characters generated so far, by kind. */
  reasoningChars: number;
  answerChars: number;
  state: GenerationState;
  /** Monotonic times (performance.now). */
  startedAt: number;
  lastProgressAt: number | null;
  firstReasoningAt: number | null;
  firstAnswerAt: number | null;
  statusSeq: number;
  lastStatusAt: number;
  statusTimer: ReturnType<typeof setTimeout> | null;
  /** The engine request has ended (its slot is free), even if text is still being published. */
  inferenceDone: boolean;
  /** Resolves when the engine request ended; true if its teardown was confirmed. */
  settled: Promise<boolean>;
  settle: (confirmed: boolean) => void;
  inFlight: Promise<void> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  done: boolean;
  completion?: WorkerDraft;
  cancelReason?: "cancelled" | "timeout" | "length" | "error";
  detail?: FinishDetail;
  lastResumeAt: number;
  expireTimer?: ReturnType<typeof setTimeout>;
}

/** Text within this long counts as "active" in status messages. */
const ACTIVE_MS = 5000;
/** Minimum spacing of state-change status messages. */
const STATUS_MIN_MS = 1000;
/** How long to wait for an aborted engine request to unwind. */
const TEARDOWN_MS = 3000;

/** Monotonic clock for elapsed times. */
const mono = () => performance.now();

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
  readonly #reasoningCache = new Map<string, { at: number; value: Promise<ReasoningSetting[]> }>();
  /** Cancellations that arrived before their chat.start ("sender:id" → expiry). */
  readonly #cancelledEarly = new Map<string, number>();
  readonly #cancelReplyLimiter = new RateLimiter(60, 20);
  #hostCache: { at: number; value: Promise<HostMetrics | null> } | null = null;

  constructor(deps: GatewayDeps) {
    this.#d = deps;
    const cfg = deps.getConfig();
    this.#userLimiter = new RateLimiter(cfg.limits.requestsPerMinute);
    this.#publicLimiter = new RateLimiter(cfg.limits.publicRequestsPerMinute);
  }

  get activeCount(): number {
    let n = 0;
    for (const s of this.#streams.values()) if (!s.inferenceDone) n++;
    return n;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  async #reply(to: string, draft: WorkerDraft, ttlSec?: number): Promise<void> {
    try {
      await this.#d.send(to, envelope(draft, ttlSec ? { ttlSec } : {}));
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
        return this.#cancel(msg.sender, replyTo, m);
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
            heartbeatSec: cfg.limits.heartbeatSec,
            inactivityTimeoutSec: cfg.limits.inactivityTimeoutSec,
            maxTokens: cfg.limits.maxTokens,
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
    const ids = cfg.models.exposed.filter((id) => discovered.has(id) || cfg.models.manual.includes(id) || this.#modelCache.models === null);
    return Promise.all(
      ids.map(async (id) => ({
        id,
        contextLength: discovered.get(id)?.contextLength,
        streaming: caps.streaming,
        cancel: caps.cancel,
        reasoningOptions: await this.reasoningOptions(id),
      })),
    );
  }

  /** Reasoning settings the engine (or the owner's config) declares for a model. */
  reasoningOptions(id: string): Promise<ReasoningSetting[]> {
    const mode = this.#d.getConfig().models.reasoning[id];
    const key = `${mode ?? ""}:${id}`;
    const hit = this.#reasoningCache.get(key);
    if (hit && this.#now() - hit.at < 60_000) return hit.value;
    const value = this.#d.provider.reasoningOptions(id, mode).catch(() => {
      this.#reasoningCache.delete(key); // engine unreachable: ask again next time
      return [];
    });
    if (this.#reasoningCache.size > 200) this.#reasoningCache.clear();
    this.#reasoningCache.set(key, { at: this.#now(), value });
    return value;
  }

  async #chat(sender: string, replyTo: string, m: ClientMessageOf<"chat.start">): Promise<void> {
    const cfg = this.#d.getConfig();
    const existing = this.#streams.get(m.id);
    if (existing) {
      // Duplicate start (client retry): acknowledge again, don't re-run.
      if (existing.sender === sender) await this.#reply(existing.replyTo, { type: "chat.ack", re: m.id, model: existing.model });
      return;
    }
    if (this.#takeEarlyCancel(sender, m.id)) {
      // Its cancellation overtook it on the way here.
      return this.#reply(replyTo, { type: "chat.complete", re: m.id, deltaCount: 0, finishReason: "cancelled", contentLength: 0 });
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

    const wanted = m.params?.reasoning;
    if (wanted && !(await this.reasoningOptions(m.model)).includes(wanted)) {
      return this.#error(replyTo, "invalid_request", m.id, { message: "This model doesn't support that reasoning setting." });
    }
    // A duplicate of this start may have been accepted while we waited.
    if (this.#streams.has(m.id)) return;

    const active = [...this.#streams.values()].filter((s) => !s.inferenceDone);
    if (active.length >= cfg.limits.maxConcurrent) return this.#error(replyTo, "busy", m.id, { retryAfter: 5 });
    if (active.filter((s) => s.sender === sender).length >= cfg.limits.perUserConcurrent) {
      return this.#error(replyTo, "busy", m.id, { retryAfter: 2, message: "You already have a response in progress." });
    }

    let settle!: (confirmed: boolean) => void;
    const settled = new Promise<boolean>((r) => (settle = r));
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
      lastFlush: mono(),
      reasoningChars: 0,
      answerChars: 0,
      state: "prompt",
      startedAt: mono(),
      lastProgressAt: null,
      firstReasoningAt: null,
      firstAnswerAt: null,
      statusSeq: 0,
      lastStatusAt: -Infinity,
      statusTimer: null,
      inferenceDone: false,
      settled,
      settle,
      inFlight: null,
      flushTimer: null,
      done: false,
      lastResumeAt: 0,
    };
    this.#streams.set(m.id, s);
    this.#d.log.info("chat started", { req: m.id.slice(0, 8), user: short(sender), model: m.model, messages: m.messages.length });

    const abort = (reason: NonNullable<ActiveStream["cancelReason"]>, detail?: FinishDetail) => {
      if (s.cancelReason || s.inferenceDone) return;
      s.cancelReason = reason;
      s.detail = detail;
      s.controller.abort();
    };
    const timeout = setTimeout(() => abort("timeout", "absolute_timeout"), cfg.limits.requestTimeoutSec * 1000);
    const tick = Math.min(1000, cfg.limits.heartbeatSec * 250, cfg.limits.inactivityTimeoutSec * 250);
    const monitor = setInterval(() => {
      const now = mono();
      // Only a pause after text was flowing is a confirmed stall. An engine
      // that has shown nothing yet may be loading, reading the prompt, or
      // reasoning without exposing it: that is bounded by the absolute timeout.
      if (s.lastProgressAt !== null && now - s.lastProgressAt > cfg.limits.inactivityTimeoutSec * 1000) return abort("timeout", "inactivity");
      if (now - s.lastStatusAt >= cfg.limits.heartbeatSec * 1000) this.#sendStatus(s);
    }, tick);

    let end: { finishReason: "stop" | "length"; usage?: TokenUsage } | undefined;
    let usage: TokenUsage | undefined;
    let failure: Extract<InferenceEvent, { type: "generation.error" }> | undefined;
    let errorCode: ErrorCode | undefined;
    let confirmed = true;
    let contextWindow: number | undefined;
    let budget = Math.min(m.params?.max_tokens ?? cfg.limits.maxTokens, cfg.limits.maxTokens);
    let clamped = false;
    let inferenceStart = mono();
    let inferenceEnd = inferenceStart;
    try {
      await this.#reply(replyTo, { type: "chat.ack", re: m.id, model: m.model });

      // Load state and window, without holding up the request if the engine is slow to answer.
      const info = await Promise.race([this.modelMetrics(m.model), sleep(1500).then(() => null)]);
      if (info?.state === "not-loaded") s.state = "loading";
      contextWindow = info?.state === "not-loaded" ? undefined : (info?.loadedContext ?? undefined);
      if (contextWindow) {
        // The budget has to fit beside the prompt (some engines reject the request
        // otherwise). Generous prompt estimate: ~3 characters per token.
        const prompt = m.messages.reduce((n, x) => n + 8 + Math.ceil(x.content.length / 3), 0);
        const room = Math.max(256, contextWindow - prompt - 64);
        if (room < budget) {
          budget = room;
          clamped = true;
        }
      }
      this.#sendStatus(s);

      const req: ChatRequest = {
        model: m.model,
        messages: m.messages,
        temperature: m.params?.temperature,
        top_p: m.params?.top_p,
        max_tokens: budget,
        systemPromptStyle: cfg.models.systemPromptStyle[m.model] ?? cfg.provider.systemPromptStyle,
        reasoning: m.params?.reasoning,
        reasoningMode: cfg.models.reasoning[m.model],
      };
      inferenceStart = mono();
      const signal = s.controller.signal;
      const aborted = new Promise<"aborted">((r) => {
        if (signal.aborted) r("aborted");
        else signal.addEventListener("abort", () => r("aborted"), { once: true });
      });
      if (!signal.aborted) {
        const it = this.#d.provider.chat(req, signal)[Symbol.asyncIterator]();
        for (;;) {
          const next = it.next();
          const r = await Promise.race([next, aborted]);
          if (r === "aborted") {
            // Don't depend on the engine reacting: wait briefly for its teardown.
            const unwound = next.then(() => it.return?.(), () => undefined).then(() => true, () => true);
            confirmed = await Promise.race([unwound, sleep(TEARDOWN_MS).then(() => false)]);
            break;
          }
          if (r.done) break;
          const ev = r.value;
          if (ev.type === "usage.update") usage = ev.usage;
          else if (ev.type === "generation.complete") end = ev;
          else if (ev.type === "generation.error") failure = ev;
          else {
            this.#onText(s, ev, cfg);
            if (s.totalChars > cfg.limits.maxResponseChars) abort("length", "response_size");
          }
        }
      }
    } catch (e) {
      if (!s.cancelReason) {
        s.cancelReason = "error";
        errorCode = "internal";
        this.#d.log.error("chat failed", { req: m.id.slice(0, 8), error: (e as Error).message });
      }
    } finally {
      inferenceEnd = mono();
      clearTimeout(timeout);
      clearInterval(monitor);
      s.inferenceDone = true; // frees the concurrency slot
      s.settle(confirmed);
    }

    let finishReason: "stop" | "length" | "cancelled" | "error" | "timeout";
    if (s.cancelReason) {
      finishReason = s.cancelReason;
      if (s.cancelReason === "timeout") errorCode = "timeout";
    } else if (failure || !end) {
      finishReason = "error";
      errorCode =
        failure?.kind === "unavailable" ? "provider_unavailable" : failure?.kind === "context_overflow" ? "too_large" : failure?.kind === "unsupported" ? "invalid_request" : "provider_error";
      if (failure?.kind === "context_overflow") s.detail = "context_full";
      else if (!failure || failure.detail === "stream ended early" || failure.detail === "stream interrupted") s.detail = "stream_ended";
      this.#d.log.warn("provider error", { req: m.id.slice(0, 8), kind: failure?.kind, error: failure?.detail });
    } else {
      finishReason = end.finishReason;
      usage = end.usage ?? usage;
    }
    const finalUsage = completeUsage({
      reported: usage,
      messages: m.messages,
      reasoningChars: s.reasoningChars,
      answerChars: s.answerChars,
      startedAt: inferenceStart,
      firstReasoningAt: s.firstReasoningAt,
      firstAnswerAt: s.firstAnswerAt,
      endedAt: inferenceEnd,
    });
    if (finishReason === "length" && !s.detail) {
      const measured = finalUsage.source === "measured";
      if (clamped || (measured && contextWindow && finalUsage.promptTokens + finalUsage.completionTokens >= contextWindow - 16)) s.detail = "context_full";
      else if (measured && finalUsage.completionTokens < budget * 0.9) s.detail = "engine_limit";
      else s.detail = "token_budget";
    }

    // Publish what's left, then the completion. After a cancel the client has
    // stopped listening, so unpublished text is dropped.
    this.#setState(s, "finishing");
    if (s.cancelReason === "cancelled") {
      s.contentLength -= s.pendingContent.length;
      s.pendingContent = s.pendingReasoning = "";
    }
    while (s.inFlight || s.pendingContent || s.pendingReasoning) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      s.flushTimer = null;
      if (s.inFlight) await s.inFlight;
      else await this.#flush(s);
    }
    for (const t of [s.flushTimer, s.statusTimer]) if (t) clearTimeout(t);
    s.flushTimer = s.statusTimer = null;
    s.done = true;
    s.completion = {
      type: "chat.complete",
      re: s.id,
      deltaCount: s.deltas.length,
      finishReason,
      errorCode,
      contentLength: s.contentLength,
      usage: { ...finalUsage, maxTokens: budget, contextWindow, detail: s.detail },
    };
    await this.#reply(s.replyTo, s.completion);
    this.#d.log.info("chat finished", {
      req: m.id.slice(0, 8),
      finishReason,
      detail: s.detail,
      sec: Math.round((inferenceEnd - inferenceStart) / 1000),
      deltas: s.deltas.length,
      chars: s.totalChars,
    });
    // Keep the transcript briefly so clients can recover lost chunks.
    s.expireTimer = setTimeout(() => this.#streams.delete(s.id), cfg.streaming.resumeBufferSec * 1000);
    s.expireTimer.unref?.();
  }

  #onText(s: ActiveStream, ev: Extract<InferenceEvent, { text: string }>, cfg: Config): void {
    const now = mono();
    s.lastProgressAt = now;
    s.totalChars += ev.text.length;
    if (ev.type === "answer.delta") {
      s.firstAnswerAt ??= now;
      s.pendingContent += ev.text;
      s.contentLength += ev.text.length;
      s.answerChars += ev.text.length;
      this.#setState(s, "answering");
    } else {
      s.firstReasoningAt ??= now;
      s.pendingReasoning += ev.text;
      s.reasoningChars += ev.text.length;
      this.#setState(s, "thinking");
    }
    this.#maybeFlush(s, cfg);
  }

  /** State changes are reported promptly, at most once per STATUS_MIN_MS. */
  #setState(s: ActiveStream, state: GenerationState): void {
    if (s.state === state) return;
    s.state = state;
    if (s.statusTimer) return;
    const wait = s.lastStatusAt + STATUS_MIN_MS - mono();
    if (wait <= 0) return this.#sendStatus(s);
    s.statusTimer = setTimeout(() => {
      s.statusTimer = null;
      this.#sendStatus(s);
    }, wait);
  }

  /** Heartbeat and live statistics. Never counts as inference progress. */
  #sendStatus(s: ActiveStream): void {
    if (s.done) return;
    const now = mono();
    s.lastStatusAt = now;
    const since = s.lastProgressAt === null ? null : Math.round(now - s.lastProgressAt);
    const first = Math.min(s.firstReasoningAt ?? Infinity, s.firstAnswerAt ?? Infinity);
    const tokens = estimateTokens(s.totalChars);
    const draft: WorkerDraft = {
      type: "chat.status",
      re: s.id,
      n: s.statusSeq++,
      state: s.state,
      progress: since === null ? "unknown" : since < ACTIVE_MS ? "active" : "quiet",
      elapsedMs: Math.round(now - s.startedAt),
      sinceProgressMs: since,
      deltaCount: s.deltas.length,
      reasoningTokens: s.reasoningChars ? estimateTokens(s.reasoningChars) : null,
      answerTokens: s.answerChars ? estimateTokens(s.answerChars) : null,
      tokensPerSecond: now - first >= 1000 ? Math.round((tokens / ((now - first) / 1000)) * 10) / 10 : null,
    };
    void this.#reply(s.replyTo, draft, 30);
  }

  /** Batch by time or size; at most one publish in flight per stream. */
  #maybeFlush(s: ActiveStream, cfg: Config): void {
    if (s.inFlight) return; // backpressure: text keeps coalescing
    const pending = s.pendingContent.length + s.pendingReasoning.length;
    if (pending === 0) return;
    const elapsed = mono() - s.lastFlush;
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
    s.lastFlush = mono();
    const p = this.#reply(s.replyTo, { type: "chat.delta", re: s.id, ...delta }).then(async () => {
      s.inFlight = null;
      if (s.pendingContent.length + s.pendingReasoning.length >= max) await this.#flush(s);
      else if (!s.done) this.#maybeFlush(s, cfg);
    });
    s.inFlight = p;
    return p;
  }

  /** Cancel the sender's own request. Safe to repeat; always answered. */
  async #cancel(sender: string, replyTo: string, m: ClientMessageOf<"chat.cancel">): Promise<void> {
    const s = this.#streams.get(m.target);
    let status: "cancelled" | "finished" | "not_found" | "unconfirmed";
    if (!s || s.sender !== sender) {
      // Never reveals other users' requests. Remember it in case the start is still on its way.
      const now = this.#now();
      for (const [k, until] of this.#cancelledEarly) if (until < now || this.#cancelledEarly.size > 1000) this.#cancelledEarly.delete(k);
      this.#cancelledEarly.set(`${sender}:${m.target}`, now + 300_000);
      status = "not_found";
    } else {
      if (!s.inferenceDone && !s.cancelReason) {
        s.cancelReason = "cancelled";
        s.controller.abort();
        this.#d.log.info("chat cancelled", { req: m.target.slice(0, 8) });
      }
      const confirmed = await Promise.race([s.settled, sleep(TEARDOWN_MS + 2000).then(() => false)]);
      status = s.cancelReason !== "cancelled" ? "finished" : confirmed ? "cancelled" : "unconfirmed";
    }
    if (this.#cancelReplyLimiter.take(sender, this.#now()) > 0) return;
    await this.#reply(replyTo, { type: "chat.cancel.result", re: m.id, target: m.target, status });
  }

  #takeEarlyCancel(sender: string, id: string): boolean {
    const until = this.#cancelledEarly.get(`${sender}:${id}`);
    return until !== undefined && until >= this.#now();
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
      if (!s.inferenceDone && !s.cancelReason) {
        s.cancelReason = "error";
        s.detail = "worker_shutdown";
        s.controller.abort();
      }
      if (s.statusTimer) clearTimeout(s.statusTimer);
      if (s.expireTimer) clearTimeout(s.expireTimer);
      if (s.flushTimer) clearTimeout(s.flushTimer);
    }
  }
}

/** Rough token estimate for text when the engine reports no usage (~4 chars/token). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * Token counts for chat.complete: the engine's when it reports them, otherwise
 * estimated from text length, each marked with its source. Durations come
 * from the worker's monotonic clock.
 */
export function completeUsage(o: {
  reported?: TokenUsage;
  messages: readonly { content: string }[];
  reasoningChars: number;
  answerChars: number;
  startedAt: number;
  firstReasoningAt: number | null;
  firstAnswerAt: number | null;
  endedAt: number;
}) {
  const r = o.reported;
  const chars = o.reasoningChars + o.answerChars;
  const promptTokens = r?.promptTokens ?? o.messages.reduce((n, x) => n + 4 + estimateTokens(x.content.length), 0);
  let completionTokens = r?.completionTokens ?? estimateTokens(chars);
  let reasoningTokens = r?.reasoningTokens;
  let answerTokens: number;
  let reasoningSource: CountSource | undefined = reasoningTokens !== undefined ? "provider" : undefined;
  let answerSource: CountSource = "estimated";
  if (reasoningTokens !== undefined && r?.completionTokens !== undefined) {
    if (reasoningTokens > r.completionTokens) {
      // This engine counts reasoning separately from completion tokens.
      answerTokens = r.completionTokens;
      completionTokens = r.completionTokens + reasoningTokens;
    } else {
      answerTokens = r.completionTokens - reasoningTokens; // included: don't count it twice
    }
    answerSource = "provider";
  } else if (o.reasoningChars > 0) {
    // Reasoning was visible but not counted separately: split by text length.
    reasoningTokens ??= Math.round((completionTokens * o.reasoningChars) / chars);
    reasoningSource ??= "estimated";
    answerTokens = Math.max(0, completionTokens - reasoningTokens);
  } else {
    // No reasoning exposed. It may have been hidden, so the split is unknown.
    answerTokens = Math.min(completionTokens, Math.max(estimateTokens(o.answerChars), o.answerChars ? 1 : 0));
  }
  const ms = (t: number | null) => (t === null ? undefined : Math.max(0, Math.round(t - o.startedAt)));
  const firstReasoningMs = ms(o.firstReasoningAt);
  const firstAnswerMs = ms(o.firstAnswerAt);
  const firstTokenMs = firstReasoningMs === undefined ? firstAnswerMs : Math.min(firstReasoningMs, firstAnswerMs ?? Infinity);
  const inferenceMs = Math.max(0, Math.round(o.endedAt - o.startedAt));
  const generationMs = firstTokenMs === undefined ? undefined : Math.max(0, inferenceMs - firstTokenMs);
  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    answerTokens,
    source: r?.promptTokens !== undefined && r?.completionTokens !== undefined ? ("measured" as const) : ("estimated" as const),
    sources: {
      prompt: (r?.promptTokens !== undefined ? "provider" : "estimated") as CountSource,
      completion: (r?.completionTokens !== undefined ? "provider" : "estimated") as CountSource,
      reasoning: reasoningSource,
      answer: answerSource,
    },
    firstTokenMs,
    firstReasoningMs,
    firstAnswerMs,
    generationMs,
    inferenceMs,
    tokensPerSecond:
      generationMs !== undefined && generationMs >= 50 && completionTokens > 0
        ? Math.round((completionTokens / (generationMs / 1000)) * 10) / 10
        : undefined,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

function replyToOf(payload: unknown): string | undefined {
  const r = (payload as { replyTo?: unknown } | null)?.replyTo;
  return typeof r === "string" && /^[0-9a-f]{64}$/.test(r) ? r : undefined;
}

export type { ClientMessage };
