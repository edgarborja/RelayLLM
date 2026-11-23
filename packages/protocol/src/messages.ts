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

export const ClientMessage = z.discriminatedUnion("type", [
  ServerInfoReq,
  ModelsListReq,
  ChatStartReq,
  ChatCancelReq,
  ChatResumeReq,
  PairReq,
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
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;

export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;
export type WorkerMessageOf<T extends WorkerMessage["type"]> = Extract<WorkerMessage, { type: T }>;

export const AnyMessage = z.union([ClientMessage, WorkerMessage]);
export type AnyMessage = ClientMessage | WorkerMessage;

export { hex64 as HexPubkey };
