/**
 * Provider abstraction. The Nostr gateway only ever talks to providers through
 * this interface; adapters never receive raw client payloads, only the
 * validated, allowlisted fields below.
 */

export type ProviderKind = "lmstudio" | "ollama" | "vllm" | "openai-compatible";

export interface ProviderModel {
  id: string;
  /** Engine-reported type when known (e.g. "llm", "vlm", "embeddings"). */
  type?: string;
  contextLength?: number;
  /** False for models that cannot do chat (e.g. embeddings). */
  chat: boolean;
  loaded?: boolean;
}

export interface ChatRequest {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export type ChatChunk =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "done";
      finishReason: "stop" | "length" | "error";
      usage?: { promptTokens?: number; completionTokens?: number };
    };

export interface ProviderHealth {
  ok: boolean;
  latencyMs?: number;
  /** Safe-to-log description, never includes credentials. */
  detail?: string;
}

export interface ProviderCapabilities {
  streaming: boolean;
  /** Aborting the HTTP request stops generation on the engine. */
  cancel: boolean;
  discovery: boolean;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  health(): Promise<ProviderHealth>;
  listModels(): Promise<ProviderModel[]>;
  /** Stream a chat completion. Abort `signal` to cancel. */
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "bad_response" | "http_error" | "timeout" | "aborted",
    readonly status?: number,
  ) {
    super(message);
  }
}
