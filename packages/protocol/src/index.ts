import {
  ClientMessage,
  DEFAULT_MESSAGE_TTL_SEC,
  MAX_MESSAGE_TTL_SEC,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  WorkerMessage,
  type ErrorCode,
} from "./messages.ts";

export * from "./messages.ts";

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 128-bit random url-safe id (22 chars). */
export function newId(): string {
  const bytes = new Uint8Array(22);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b & 63];
  return out;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ClientDraft = DistributiveOmit<ClientMessage, "v" | "id" | "exp">;
export type WorkerDraft = DistributiveOmit<WorkerMessage, "v" | "id" | "exp">;

/** Fill in protocol envelope fields (version, fresh id, expiry). */
export function envelope<T extends ClientDraft | WorkerDraft>(
  draft: T,
  opts: { ttlSec?: number; id?: string } = {},
): T & { v: number; id: string; exp: number } {
  return {
    v: PROTOCOL_VERSION,
    id: opts.id ?? newId(),
    exp: nowSec() + (opts.ttlSec ?? DEFAULT_MESSAGE_TTL_SEC),
    ...draft,
  };
}

export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; code: ErrorCode; reason: string; id?: string };

function preflight(raw: unknown, now: number): ParseResult<never> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, code: "invalid_request", reason: "not an object" };
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(r.id) ? r.id : undefined;
  if (typeof r.v !== "number" || !SUPPORTED_VERSIONS.includes(r.v)) {
    return { ok: false, code: "unsupported_version", reason: "unsupported protocol version", id };
  }
  if (typeof r.exp !== "number") return { ok: false, code: "invalid_request", reason: "missing exp", id };
  if (r.exp < now) return { ok: false, code: "expired", reason: "message expired", id };
  if (r.exp > now + MAX_MESSAGE_TTL_SEC) {
    return { ok: false, code: "invalid_request", reason: "expiry too far in future", id };
  }
  return null;
}

/** Validate an untrusted client → worker message. */
export function parseClientMessage(raw: unknown, now = nowSec()): ParseResult<ClientMessage> {
  const pre = preflight(raw, now);
  if (pre) return pre;
  const res = ClientMessage.safeParse(raw);
  if (!res.success) {
    const id = (raw as { id?: unknown }).id;
    return {
      ok: false,
      code: "invalid_request",
      reason: "schema validation failed",
      id: typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : undefined,
    };
  }
  return { ok: true, message: res.data };
}

/** Validate an untrusted worker → client message. */
export function parseWorkerMessage(raw: unknown, now = nowSec()): ParseResult<WorkerMessage> {
  const pre = preflight(raw, now);
  if (pre) return pre;
  const res = WorkerMessage.safeParse(raw);
  if (!res.success) return { ok: false, code: "invalid_request", reason: "schema validation failed" };
  return { ok: true, message: res.data };
}

/** Human-readable explanations for error codes, safe to show to anyone. */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  unauthorized: "This worker has not authorized your identity.",
  pending_approval: "Access requested. Waiting for the worker owner to approve.",
  rate_limited: "Too many requests. Please wait and try again.",
  busy: "The worker is busy. Please try again shortly.",
  invalid_request: "The request was rejected as invalid.",
  unsupported_version: "Client and worker protocol versions are incompatible.",
  model_unavailable: "That model is not available.",
  provider_unavailable: "The worker's AI engine is not reachable.",
  provider_error: "The AI engine returned an error.",
  timeout: "The request timed out.",
  too_large: "The request or response is too large.",
  not_found: "Unknown request.",
  expired: "The request expired before it was processed.",
  internal: "The worker encountered an internal error.",
};
