import type { EngineStats, MetricsSupport, ModelRuntimeInfo } from "./metrics.ts";
import type { ReasoningMode, ReasoningSetting } from "./inference.ts";
import type { SystemPromptStyle } from "./system-prompt.ts";

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
  /** System messages, if any, come first (the worker enforces this). */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /**
   * How to deliver the system instructions to this engine/model. Chosen by
   * the worker's own config, never by the client. Defaults to the adapter's.
   */
  systemPromptStyle?: SystemPromptStyle;
  /** Omitted = the model's default ("auto"). Validated by the worker. */
  reasoning?: ReasoningSetting;
  /** Owner-declared control for engines that don't advertise one. */
  reasoningMode?: ReasoningMode;
}

export interface TokenUsage {
  promptTokens?: number;
  /** Total generated tokens, as the engine counts them. */
  completionTokens?: number;
  reasoningTokens?: number;
}

export type ErrorKind = "unavailable" | "bad_response" | "http_error" | "timeout" | "context_overflow" | "unsupported";

/**
 * Normalized inference events. Every stream ends with exactly one
 * generation.complete or generation.error, unless it was aborted (the
 * iterator then throws ProviderError "aborted").
 */
export type InferenceEvent =
  | { type: "reasoning.delta"; text: string }
  | { type: "answer.delta"; text: string }
  | { type: "usage.update"; usage: TokenUsage }
  | { type: "generation.complete"; finishReason: "stop" | "length"; usage?: TokenUsage }
  | { type: "generation.error"; kind: ErrorKind; /** Safe to log; never sent to clients. */ detail: string };

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
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
  /** Reasoning settings the model accepts (empty: no control). */
  reasoningOptions(id: string, mode?: ReasoningMode): Promise<ReasoningSetting[]>;
  readonly metricsSupport: MetricsSupport;
  /** Read-only metadata and load state for one model (fixed engine endpoints only). */
  modelInfo(id: string): Promise<ModelRuntimeInfo>;
  /** Engine-wide stats, or null when the engine has none. */
  engineStats(): Promise<EngineStats | null>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ErrorKind | "aborted",
    readonly status?: number,
  ) {
    super(message);
  }
}
