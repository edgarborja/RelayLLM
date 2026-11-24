import type { Limits, WorkerMessageOf } from "@relayllm/protocol";
import { buildContext } from "./context.ts";
import type { ChatMessageRecord } from "./db.ts";

export type UsageRecord = NonNullable<WorkerMessageOf<"chat.complete">["usage"]>;

/** Rough token count for text (~4 characters per token, plus per-message overhead). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
const MESSAGE_OVERHEAD = 4;

export interface ContextEstimate {
  /** Tokens the next request would carry before the user types anything. */
  tokens: number;
  /**
   * measured: exactly what the engine counted for the last request;
   * mixed: last measured request plus estimates for newer text;
   * estimated: from text length only (engine reported no usage).
   */
  basis: "measured" | "mixed" | "estimated" | "none";
  /** Usage of the latest completed reply in this conversation. */
  last?: UsageRecord;
}

/**
 * Estimate how much context the next request in a conversation uses. When the
 * engine measured the last request, its prompt plus visible output is exact;
 * reasoning tokens are not sent back, so they're excluded.
 */
export function estimateContext(messages: readonly ChatMessageRecord[], systemPrompt: string | undefined, limits: Limits | undefined): ContextEstimate {
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant" && m.usage && m.status !== "streaming");
  const ctx = buildContext(messages as ChatMessageRecord[], limits, systemPrompt);
  const estimateAll = () => ctx.messages.reduce((n, m) => n + MESSAGE_OVERHEAD + estimateTokens(m.content), 0);
  if (ctx.messages.length === 0) return { tokens: 0, basis: "none" };

  const u = lastReply?.usage;
  if (lastReply && u?.source === "measured" && u.promptTokens !== undefined && u.completionTokens !== undefined) {
    const visibleOutput = u.sources?.answer === "provider" && u.answerTokens !== undefined ? u.answerTokens : Math.max(0, u.completionTokens - (u.reasoningTokens ?? 0));
    const after = messages.slice(messages.indexOf(lastReply) + 1).filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim() && m.status !== "error");
    const extra = after.reduce((n, m) => n + MESSAGE_OVERHEAD + estimateTokens(m.content), 0);
    return { tokens: u.promptTokens + visibleOutput + extra, basis: extra ? "mixed" : "measured", last: u };
  }
  return { tokens: estimateAll(), basis: messages.some((m) => m.role !== "system") || systemPrompt?.trim() ? "estimated" : "none", last: u };
}

// ---------------------------------------------------------------- formatting

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

export function fmtCompact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function fmtAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}
