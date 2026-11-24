import { z } from "zod";

/**
 * RelayLLM application protocol, version 1.
 *
 * Every message is a JSON object carried as the `content` of a signed inner
 * Nostr event (see @relayllm/nostr-transport). The inner event's signature —
 * not any field in this payload — is the sender's identity.
 *
 * Client → worker requests carry a fresh `id`; worker responses reference it
 * in `re`. Chat streams are keyed by the `chat.start` message id.
 */

export const PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_VERSIONS: readonly number[] = [1];

/** Default lifetime of a message before receivers must drop it. */
export const DEFAULT_MESSAGE_TTL_SEC = 120;
/** Receivers reject `exp` further than this into the future. */
export const MAX_MESSAGE_TTL_SEC = 600;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** Message/request ids: 16–64 url-safe chars, generated with a CSPRNG. */
export const MessageId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

const base = {
  v: z.number().int().positive(),
  id: MessageId,
  /** Unix seconds after which the message must be ignored. */
  exp: z.number().int().positive(),
};

const clientBase = {
  ...base,
  /**
   * Public key the worker must encrypt responses to. Lets a client receive
   * replies on a per-session key (fewer signer prompts, and the long-term
   * user key never appears in relay-visible tags). Defaults to the sender.
   */
  replyTo: hex64.optional(),
};

// ---------------------------------------------------------------- requests

export const ChatRole = z.enum(["system", "user", "assistant"]);
export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string().max(2_000_000),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Generation parameters. Only these are ever forwarded to a provider. */
export const ChatParams = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
export type ChatParams = z.infer<typeof ChatParams>;

export const ServerInfoReq = z.object({ ...clientBase, type: z.literal("server.info") }).strict();

export const ModelsListReq = z.object({ ...clientBase, type: z.literal("models.list") }).strict();

export const ChatStartReq = z
  .object({
    ...clientBase,
    type: z.literal("chat.start"),
    model: z.string().min(1).max(256),
    messages: z.array(ChatMessage).min(1).max(1000),
    params: ChatParams.optional(),
  })
  .strict();

export const ChatCancelReq = z
  .object({ ...clientBase, type: z.literal("chat.cancel"), target: MessageId })
  .strict();

/** Ask the worker to re-send buffered stream chunks (lost ephemeral events). */
export const ChatResumeReq = z
  .object({
    ...clientBase,
    type: z.literal("chat.resume"),
    target: MessageId,
    /** Sequence numbers the client is missing (bounded). */
    missing: z.array(z.number().int().min(0)).max(1000).optional(),
    /** Re-send every chunk with seq >= fromSeq, and the completion if done. */
    fromSeq: z.number().int().min(0).optional(),
  })
  .strict();

export const PairReq = z
  .object({
    ...clientBase,
    type: z.literal("pair.request"),
    /** Single-use invitation token from a pairing link, if any. */
    token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
    /** Optional human label the owner sees when approving. */
    label: z.string().max(64).optional(),
  })
  .strict();

/**
 * Read-only metrics for the context indicator. `model` must be a model exposed
 * to the caller. `host` asks for machine memory stats; the worker includes
 * them only if its owner enabled host monitoring.
 */
export const MetricsReq = z
  .object({
    ...clientBase,
    type: z.literal("metrics.get"),
    model: z.string().min(1).max(256).optional(),
    host: z.boolean().optional(),
  })
  .strict();

export const ClientMessage = z.discriminatedUnion("type", [
  ServerInfoReq,
  ModelsListReq,
  ChatStartReq,
  ChatCancelReq,
  ChatResumeReq,
  PairReq,
  MetricsReq,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------- responses

export const ModelInfo = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextLength: z.number().int().positive().optional(),
  streaming: z.boolean(),
  cancel: z.boolean(),
  reasoning: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const Limits = z.object({
  maxRequestBytes: z.number().int(),
  maxResponseChars: z.number().int(),
  maxMessages: z.number().int(),
  requestTimeoutSec: z.number().int(),
  /** Max total length of leading system instructions (optional for older workers). */
  maxSystemPromptChars: z.number().int().optional(),
});
export type Limits = z.infer<typeof Limits>;

export const ServerInfoRes = z
  .object({
    ...base,
    type: z.literal("server.info.result"),
    re: MessageId,
    name: z.string().max(128),
    software: z.string().max(64),
    versions: z.array(z.number().int()),
    streaming: z.object({ batchMs: z.number().int(), resume: z.boolean() }),
    limits: Limits,
  })
  .strict();

export const ModelsListRes = z
  .object({
    ...base,
    type: z.literal("models.list.result"),
    re: MessageId,
    models: z.array(ModelInfo).max(500),
  })
  .strict();

export const ChatAck = z
  .object({ ...base, type: z.literal("chat.ack"), re: MessageId, model: z.string() })
  .strict();

export const ChatDelta = z
  .object({
    ...base,
    type: z.literal("chat.delta"),
    re: MessageId,
    seq: z.number().int().min(0),
    content: z.string().optional(),
    reasoning: z.string().optional(),
  })
  .strict();

export const TokenSource = z.enum(["measured", "estimated"]);
export type TokenSource = z.infer<typeof TokenSource>;

export const FinishReason = z.enum(["stop", "length", "cancelled", "error", "timeout"]);

export const ChatComplete = z
  .object({
    ...base,
    type: z.literal("chat.complete"),
    re: MessageId,
    /** Number of chat.delta messages sent (seq 0..deltaCount-1). */
    deltaCount: z.number().int().min(0),
    finishReason: FinishReason,
    /** Sanitized error code when finishReason is "error" or "timeout". */
    errorCode: z.lazy(() => ErrorCode).optional(),
    /** Total characters of `content` text, for integrity checking. */
    contentLength: z.number().int().min(0),
    usage: z
      .object({
        promptTokens: z.number().int().optional(),
        completionTokens: z.number().int().optional(),
        /** Part of completionTokens spent on reasoning, when reported. */
        reasoningTokens: z.number().int().optional(),
        /** "measured": counted by the engine; "estimated": from text length. */
        source: TokenSource.optional(),
        /** Output tokens per second, from first token to end of generation. */
        tokensPerSecond: z.number().nonnegative().optional(),
        /** Time from request to first generated token. */
        firstTokenMs: z.number().int().nonnegative().optional(),
        generationMs: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .strict();

export const ErrorCode = z.enum([
  "unauthorized",
  "pending_approval",
  "rate_limited",
  "busy",
  "invalid_request",
  "unsupported_version",
  "model_unavailable",
  "provider_unavailable",
  "provider_error",
  "timeout",
  "too_large",
  "not_found",
  "expired",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerError = z
  .object({
    ...base,
    type: z.literal("server.error"),
    re: MessageId.optional(),
    code: ErrorCode,
    message: z.string().max(500),
    /** Seconds the client should wait before retrying, when relevant. */
    retryAfter: z.number().int().optional(),
    versions: z.array(z.number().int()).optional(),
  })
  .strict();

// ---------------------------------------------------------------- metrics
//
// Every value is nullable: null means "unavailable" (the engine or platform
// doesn't report it), never zero. Timestamps are Unix milliseconds of when
// the value was read.

const bytes = z.number().nonnegative().nullable();
const count = z.number().int().nonnegative().nullable();
const label = z.string().max(64).nullable();

export const ModelMetrics = z
  .object({
    id: z.string().max(256),
    at: z.number().int(),
    state: z.enum(["loaded", "not-loaded", "unknown"]),
    /** The model's theoretical maximum context (what it was trained for). */
    maxContext: count,
    /** The context window currently configured or allocated by the engine. */
    loadedContext: count,
    /** Memory used by the loaded model, as reported by the engine. */
    memoryBytes: bytes,
    /** Part of memoryBytes in GPU memory, when reported separately. */
    vramBytes: bytes,
    /** Size of the model weights on disk. */
    sizeBytes: bytes,
    architecture: label,
    quantization: label,
    parameters: label,
  })
  .strict();
export type ModelMetrics = z.infer<typeof ModelMetrics>;

export const EngineMetrics = z
  .object({
    at: z.number().int(),
    /** Fraction (0–1) of the engine's KV cache in use. */
    kvCacheUsage: z.number().min(0).max(1).nullable(),
    requestsRunning: count,
    requestsWaiting: count,
  })
  .strict();
export type EngineMetrics = z.infer<typeof EngineMetrics>;

export const HostMetrics = z
  .object({
    at: z.number().int(),
    platform: z.enum(["macos", "linux", "windows", "other"]),
    memTotalBytes: bytes,
    memAvailableBytes: bytes,
    memUsedPercent: z.number().min(0).max(100).nullable(),
    swapTotalBytes: bytes,
    swapUsedBytes: bytes,
    /** OS memory pressure level (macOS natively; Linux from PSI). */
    pressure: z.enum(["normal", "warning", "critical"]).nullable(),
  })
  .strict();
export type HostMetrics = z.infer<typeof HostMetrics>;

export const MetricsRes = z
  .object({
    ...base,
    type: z.literal("metrics.result"),
    re: MessageId,
    at: z.number().int(),
    provider: z.enum(["lmstudio", "ollama", "vllm", "openai-compatible"]),
    /** Null if no model was requested or the engine couldn't be reached. */
    model: ModelMetrics.nullable(),
    /** Engine-wide stats (vLLM Prometheus), only if the owner enabled them. */
    engine: EngineMetrics.nullable(),
    /** Machine stats, only if requested and the owner enabled host monitoring. */
    host: HostMetrics.nullable(),
    monitoring: z
      .object({
        host: z.boolean(),
        /** How often clients should refresh while the panel is open. */
        refreshSec: z.number().int().min(1),
      })
      .strict(),
  })
  .strict();
export type MetricsResult = z.infer<typeof MetricsRes>;

export const PairRes = z
  .object({
    ...base,
    type: z.literal("pair.result"),
    re: MessageId,
    status: z.enum(["approved", "pending", "denied"]),
  })
  .strict();

export const WorkerMessage = z.discriminatedUnion("type", [
  ServerInfoRes,
  ModelsListRes,
  ChatAck,
  ChatDelta,
  ChatComplete,
  ServerError,
  PairRes,
  MetricsRes,
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;

export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;
export type WorkerMessageOf<T extends WorkerMessage["type"]> = Extract<WorkerMessage, { type: T }>;

export const AnyMessage = z.union([ClientMessage, WorkerMessage]);
export type AnyMessage = ClientMessage | WorkerMessage;

export { hex64 as HexPubkey };
