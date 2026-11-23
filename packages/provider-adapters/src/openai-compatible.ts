import { checkProviderEndpoint } from "./endpoint-policy.ts";
import { readSse } from "./sse.ts";
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
  readonly #streaming: boolean;

  constructor(opts: OpenAICompatibleOptions) {
    const check = checkProviderEndpoint(opts.baseUrl, { allowRemote: opts.allowRemoteEndpoint });
    if (!check.ok || !check.url) throw new Error(`Invalid provider endpoint: ${check.reason}`);
    this.base = check.url;
    this.apiKey = opts.apiKey || undefined;
    this.metaTimeoutMs = opts.metaTimeoutMs ?? 5000;
    this.fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#streaming = opts.streaming ?? true;
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

  protected async getJson(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetch(url, {
        headers: this.headers(),
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
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
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
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    try {
      for await (const data of readSse(res.body, signal)) {
        if (signal.aborted) throw new ProviderError("aborted", "aborted");
        if (data === "[DONE]") break;
        let obj: {
          choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: unknown;
        };
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        if (obj.error) throw new ProviderError("engine reported an error", "bad_response");
        if (obj.usage) {
          usage = { promptTokens: obj.usage.prompt_tokens, completionTokens: obj.usage.completion_tokens };
        }
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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
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
      usage: obj.usage
        ? { promptTokens: obj.usage.prompt_tokens, completionTokens: obj.usage.completion_tokens }
        : undefined,
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
}
