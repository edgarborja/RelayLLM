import { checkProviderEndpoint } from "./endpoint-policy.ts";
import { readSse } from "./sse.ts";
import { applySystemPromptStyle, type SystemPromptStyle } from "./system-prompt.ts";
import {
  nonNeg,
  parsePrometheus,
  posInt,
  shortLabel,
  type EngineStats,
  type MetricsSupport,
  type ModelRuntimeInfo,
} from "./metrics.ts";
import {
  ProviderError,
  type ChatChunk,
  type ChatRequest,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderHealth,
  type ProviderKind,
  type ProviderModel,
} from "./types.ts";

export interface OpenAICompatibleOptions {
  /** Base URL including the OpenAI prefix, e.g. http://localhost:1234/v1 */
  baseUrl: string;
  apiKey?: string;
  allowRemoteEndpoint?: boolean;
  /** Set false for engines that can't stream; responses arrive in one piece. */
  streaming?: boolean;
  /** Timeout for discovery/health calls. */
  metaTimeoutMs?: number;
  /** vLLM: read the local Prometheus endpoint ({origin}/metrics) for engine stats. */
  engineMetrics?: boolean;
  /** Default convention for system instructions (see system-prompt.ts). */
  systemPromptStyle?: SystemPromptStyle;
  fetchImpl?: typeof fetch;
}

const EMBEDDING_HINT = /embed|embedding|bge-|e5-|nomic-embed|rerank/i;

/**
 * Adapter for any OpenAI-compatible /v1 API. Only three fixed paths are ever
 * requested: GET {base}/models, POST {base}/chat/completions, plus
 * adapter-specific discovery paths defined in subclasses.
 */
export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly kind: ProviderKind = "openai-compatible";
  readonly capabilities: ProviderCapabilities;
  protected readonly base: URL;
  protected readonly apiKey?: string;
  protected readonly metaTimeoutMs: number;
  protected readonly fetch: typeof fetch;
  protected readonly systemPromptStyle: SystemPromptStyle;
  protected readonly engineMetricsEnabled: boolean;
  readonly metricsSupport: MetricsSupport = { loadState: false, maxContext: false, loadedContext: false, memory: false, engineStats: false };
  readonly #streaming: boolean;

  constructor(opts: OpenAICompatibleOptions) {
    const check = checkProviderEndpoint(opts.baseUrl, { allowRemote: opts.allowRemoteEndpoint });
    if (!check.ok || !check.url) throw new Error(`Invalid provider endpoint: ${check.reason}`);
    this.base = check.url;
    this.apiKey = opts.apiKey || undefined;
    this.metaTimeoutMs = opts.metaTimeoutMs ?? 5000;
    this.fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#streaming = opts.streaming ?? true;
    this.systemPromptStyle = opts.systemPromptStyle ?? "system";
    this.engineMetricsEnabled = opts.engineMetrics ?? false;
    this.capabilities = { streaming: this.#streaming, cancel: true, discovery: true };
  }

  /** Build a URL under the configured base. `path` is always a constant. */
  protected url(path: string): string {
    return `${this.base.toString().replace(/\/+$/, "")}${path}`;
  }

  /** Origin-relative URL (for engine-native APIs outside the /v1 prefix). */
  protected originUrl(path: string): string {
    return `${this.base.origin}${path}`;
  }

  protected headers(json = false): Record<string, string> {
    const h: Record<string, string> = { accept: json ? "application/json" : "text/event-stream, application/json" };
    if (json) h["content-type"] = "application/json";
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  protected async getJson(url: string, post?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetch(url, {
        method: post === undefined ? "GET" : "POST",
        headers: this.headers(post !== undefined),
        body: post === undefined ? undefined : JSON.stringify(post),
        redirect: "error",
        signal: AbortSignal.timeout(this.metaTimeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      throw new ProviderError(name === "TimeoutError" ? "timed out" : "connection failed", "unavailable");
    }
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, "http_error", res.status);
    try {
      return await res.json();
    } catch {
      throw new ProviderError("invalid JSON", "bad_response");
    }
  }

  /** Bounded text GET (e.g. Prometheus metrics). */
  protected async getText(url: string, maxBytes = 2_000_000): Promise<string> {
    let res: Response;
    try {
      res = await this.fetch(url, { headers: { accept: "text/plain" }, redirect: "error", signal: AbortSignal.timeout(this.metaTimeoutMs) });
    } catch (e) {
      throw new ProviderError((e as Error).name === "TimeoutError" ? "timed out" : "connection failed", "unavailable");
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderError(`HTTP ${res.status}`, "http_error", res.status);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError("response too large", "bad_response");
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  /**
   * Generic OpenAI-compatible servers: only what /v1/models carries. Some
   * servers add fields (vLLM: max_model_len; llama.cpp: meta.n_ctx_train).
   */
  async modelInfo(id: string): Promise<ModelRuntimeInfo> {
    const entry = await this.findModelEntry(id);
    const meta = (entry?.meta ?? {}) as Record<string, unknown>;
    return {
      id,
      state: "unknown",
      maxContext: posInt(meta.n_ctx_train),
      loadedContext: posInt(entry?.max_model_len),
      sizeBytes: nonNeg(meta.size),
      parameters: typeof meta.n_params === "number" ? formatParams(meta.n_params) : undefined,
    };
  }

  protected async findModelEntry(id: string): Promise<Record<string, unknown> | undefined> {
    const body = (await this.getJson(this.url("/models"))) as { data?: Record<string, unknown>[] };
    return Array.isArray(body?.data) ? body.data.find((m) => m?.id === id) : undefined;
  }

  async engineStats(): Promise<EngineStats | null> {
    return null;
  }

  async health(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      await this.getJson(this.url("/models"));
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const body = (await this.getJson(this.url("/models"))) as { data?: { id?: unknown }[] };
    if (!body || !Array.isArray(body.data)) throw new ProviderError("unexpected /models response", "bad_response");
    return body.data
      .filter((m): m is { id: string } => typeof m?.id === "string" && m.id.length > 0 && m.id.length <= 256)
      .map((m) => ({ id: m.id, chat: !EMBEDDING_HINT.test(m.id) }));
  }

  /** Map an engine stream delta to chunks. Subclasses may extend. */
  protected parseDelta(delta: Record<string, unknown>): ChatChunk[] {
    const out: ChatChunk[] = [];
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) out.push({ type: "reasoning", text: reasoning });
    if (typeof delta.content === "string" && delta.content) out.push({ type: "content", text: delta.content });
    return out;
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
    // Allowlisted body: no tools, functions, response_format, logit_bias, etc.
    const body: Record<string, unknown> = {
      model: req.model,
      messages: applySystemPromptStyle(req.messages, req.systemPromptStyle ?? this.systemPromptStyle),
      stream: this.#streaming,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (this.#streaming) body.stream_options = { include_usage: true };

    let res: Response;
    try {
      res = await this.fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw new ProviderError("aborted", "aborted");
      throw new ProviderError(`request failed: ${(e as Error).name}`, "unavailable");
    }
    if (!res.ok || !res.body) {
      // Drain a bounded amount for status only; never forward engine text.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      throw new ProviderError(`HTTP ${res.status}`, "http_error", res.status);
    }

    const ctype = res.headers.get("content-type") ?? "";
    if (!this.#streaming || ctype.includes("application/json")) {
      yield* this.#fromJson(res);
      return;
    }

    let finish: "stop" | "length" | "error" = "stop";
    let usage: ReturnType<typeof mapUsage> | undefined;
    try {
      for await (const data of readSse(res.body, signal)) {
        if (signal.aborted) throw new ProviderError("aborted", "aborted");
        if (data === "[DONE]") break;
        let obj: {
          choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
          usage?: RawUsage;
          error?: unknown;
        };
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        if (obj.error) throw new ProviderError("engine reported an error", "bad_response");
        if (obj.usage) usage = mapUsage(obj.usage);
        const choice = obj.choices?.[0];
        if (!choice) continue;
        if (choice.delta) {
          for (const c of this.parseDelta(choice.delta)) {
            if (signal.aborted) throw new ProviderError("aborted", "aborted");
            yield c;
          }
        }
        if (choice.finish_reason === "length") finish = "length";
      }
    } catch (e) {
      if (signal.aborted) throw new ProviderError("aborted", "aborted");
      if (e instanceof ProviderError) throw e;
      throw new ProviderError("stream interrupted", "bad_response");
    }
    yield { type: "done", finishReason: finish, usage };
  }

  async *#fromJson(res: Response): AsyncIterable<ChatChunk> {
    let obj: {
      choices?: { message?: Record<string, unknown>; finish_reason?: string }[];
      usage?: RawUsage;
    };
    try {
      obj = (await res.json()) as typeof obj;
    } catch {
      throw new ProviderError("invalid JSON", "bad_response");
    }
    const choice = obj.choices?.[0];
    if (!choice?.message) throw new ProviderError("no choices", "bad_response");
    yield* this.parseDelta(choice.message);
    yield {
      type: "done",
      finishReason: choice.finish_reason === "length" ? "length" : "stop",
      usage: obj.usage ? mapUsage(obj.usage) : undefined,
    };
  }
}

/**
 * LM Studio (including Bionic). Uses the native /api/v0/models endpoint for
 * richer discovery (model type, context length, load state) and falls back to
 * /v1/models.
 */
export class LMStudioProvider extends OpenAICompatibleProvider {
  override readonly kind: ProviderKind = "lmstudio";
  override readonly metricsSupport: MetricsSupport = { loadState: true, maxContext: true, loadedContext: true, memory: false, engineStats: false };

  /**
   * Native REST API: /api/v1/models (LM Studio 0.4+/Bionic) has the loaded
   * instances' configured context; /api/v0/models is the fallback.
   * Inference still goes through the OpenAI-compatible /v1 endpoints.
   */
  override async modelInfo(id: string): Promise<ModelRuntimeInfo> {
    try {
      const body = (await this.getJson(this.originUrl("/api/v1/models"))) as { models?: Record<string, unknown>[] };
      if (Array.isArray(body?.models)) {
        const m = body.models.find(
          (x) =>
            x?.key === id ||
            (Array.isArray(x?.variants) && x.variants.includes(id)) ||
            (Array.isArray(x?.loaded_instances) && x.loaded_instances.some((i: { id?: unknown }) => i?.id === id)),
        );
        if (m) {
          const instances = Array.isArray(m.loaded_instances) ? (m.loaded_instances as { id?: unknown; config?: { context_length?: unknown } }[]) : [];
          const inst = instances.find((i) => i?.id === id) ?? instances[0];
          const quant = m.quantization as { name?: unknown } | undefined;
          return {
            id,
            state: instances.length ? "loaded" : "not-loaded",
            maxContext: posInt(m.max_context_length),
            loadedContext: posInt(inst?.config?.context_length),
            sizeBytes: nonNeg(m.size_bytes),
            architecture: shortLabel(m.architecture),
            quantization: shortLabel(quant?.name),
            parameters: shortLabel(m.params_string),
          };
        }
      }
    } catch {
      /* older LM Studio: fall back to v0 */
    }
    const body = (await this.getJson(this.originUrl("/api/v0/models"))) as { data?: Record<string, unknown>[] };
    const m = Array.isArray(body?.data) ? body.data.find((x) => x?.id === id) : undefined;
    if (!m) return { id, state: "unknown" };
    return {
      id,
      state: m.state === "loaded" ? "loaded" : m.state === "not-loaded" ? "not-loaded" : "unknown",
      maxContext: posInt(m.max_context_length),
      loadedContext: m.state === "loaded" ? posInt(m.loaded_context_length) : undefined,
      architecture: shortLabel(m.arch),
      quantization: shortLabel(m.quantization),
    };
  }

  override async listModels(): Promise<ProviderModel[]> {
    try {
      const body = (await this.getJson(this.originUrl("/api/v0/models"))) as {
        data?: { id?: unknown; type?: unknown; max_context_length?: unknown; loaded_context_length?: unknown; state?: unknown }[];
      };
      if (body && Array.isArray(body.data)) {
        return body.data
          .filter((m) => typeof m?.id === "string" && m.id.length > 0 && m.id.length <= 256)
          .map((m) => {
            const type = typeof m.type === "string" ? m.type : undefined;
            const ctx = typeof m.loaded_context_length === "number" ? m.loaded_context_length : m.max_context_length;
            return {
              id: m.id as string,
              type,
              chat: type ? type === "llm" || type === "vlm" : !EMBEDDING_HINT.test(m.id as string),
              contextLength: typeof ctx === "number" ? ctx : undefined,
              loaded: m.state === "loaded",
            };
          });
      }
    } catch {
      /* fall back to OpenAI listing */
    }
    return super.listModels();
  }
}

/** Ollama: OpenAI-compatible chat at /v1, native discovery at /api/tags. */
export class OllamaProvider extends OpenAICompatibleProvider {
  override readonly kind: ProviderKind = "ollama";
  override readonly metricsSupport: MetricsSupport = { loadState: true, maxContext: true, loadedContext: true, memory: true, engineStats: false };

  /** /api/ps (load state, memory, allocated context) + /api/show (model limits, num_ctx). */
  override async modelInfo(id: string): Promise<ModelRuntimeInfo> {
    const [ps, show] = await Promise.allSettled([
      this.getJson(this.originUrl("/api/ps")) as Promise<{ models?: Record<string, unknown>[] }>,
      this.getJson(this.originUrl("/api/show"), { model: id }) as Promise<{
        model_info?: Record<string, unknown>;
        details?: Record<string, unknown>;
        parameters?: unknown;
      }>,
    ]);
    if (ps.status === "rejected" && show.status === "rejected") throw ps.reason;
    const info: ModelRuntimeInfo = { id, state: "unknown" };
    if (ps.status === "fulfilled" && Array.isArray(ps.value?.models)) {
      const running = ps.value.models.find((m) => m?.model === id || m?.name === id);
      info.state = running ? "loaded" : "not-loaded";
      if (running) {
        info.memoryBytes = nonNeg(running.size);
        info.vramBytes = nonNeg(running.size_vram);
        info.loadedContext = posInt(running.context_length);
      }
    }
    if (show.status === "fulfilled" && show.value) {
      const mi = show.value.model_info ?? {};
      const key = Object.keys(mi).find((k) => k.endsWith(".context_length"));
      info.maxContext = key ? posInt(mi[key]) : undefined;
      const d = show.value.details ?? {};
      info.architecture = shortLabel(d.family);
      info.quantization = shortLabel(d.quantization_level);
      info.parameters = shortLabel(d.parameter_size);
      // A model-level num_ctx is the configured window when not loaded (Ollama's
      // built-in default varies by version and isn't reported, so we don't guess).
      if (info.loadedContext === undefined && typeof show.value.parameters === "string") {
        const n = /^\s*num_ctx\s+(\d+)/m.exec(show.value.parameters);
        if (n) info.loadedContext = posInt(Number(n[1]));
      }
    }
    return info;
  }

  override async health(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      await this.getJson(this.originUrl("/api/version"));
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch {
      return super.health();
    }
  }

  override async listModels(): Promise<ProviderModel[]> {
    try {
      const body = (await this.getJson(this.originUrl("/api/tags"))) as {
        models?: { name?: unknown; model?: unknown; details?: { family?: unknown } }[];
      };
      if (body && Array.isArray(body.models)) {
        return body.models
          .map((m) => (typeof m?.model === "string" ? m.model : typeof m?.name === "string" ? m.name : ""))
          .filter((id) => id.length > 0 && id.length <= 256)
          .map((id) => ({ id, chat: !EMBEDDING_HINT.test(id) }));
      }
    } catch {
      /* fall back */
    }
    return super.listModels();
  }
}

/** vLLM: plain OpenAI-compatible server. */
export class VLLMProvider extends OpenAICompatibleProvider {
  override readonly kind: ProviderKind = "vllm";
  override readonly metricsSupport: MetricsSupport = { loadState: true, maxContext: false, loadedContext: true, memory: false, engineStats: true };

  /** vLLM serves only loaded models; max_model_len is the configured window. */
  override async modelInfo(id: string): Promise<ModelRuntimeInfo> {
    const entry = await this.findModelEntry(id);
    if (!entry) return { id, state: "unknown" };
    return { id, state: "loaded", loadedContext: posInt(entry.max_model_len) };
  }

  /** Optional: a fixed allowlist of samples from the local Prometheus endpoint. */
  override async engineStats(): Promise<EngineStats | null> {
    if (!this.engineMetricsEnabled) return null;
    const names = ["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc", "vllm:num_requests_running", "vllm:num_requests_waiting"];
    const m = parsePrometheus(await this.getText(this.originUrl("/metrics")), names);
    const kv = m.get("vllm:kv_cache_usage_perc") ?? m.get("vllm:gpu_cache_usage_perc");
    return {
      kvCacheUsage: kv === undefined ? undefined : Math.min(1, Math.max(0, kv)),
      requestsRunning: m.has("vllm:num_requests_running") ? Math.round(m.get("vllm:num_requests_running")!) : undefined,
      requestsWaiting: m.has("vllm:num_requests_waiting") ? Math.round(m.get("vllm:num_requests_waiting")!) : undefined,
    };
  }
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

function mapUsage(u: RawUsage): { promptTokens?: number; completionTokens?: number; reasoningTokens?: number } {
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  return {
    promptTokens: int(u.prompt_tokens),
    completionTokens: int(u.completion_tokens),
    reasoningTokens: int(u.completion_tokens_details?.reasoning_tokens),
  };
}

function formatParams(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${Math.round(n / 1e6)}M`;
}
