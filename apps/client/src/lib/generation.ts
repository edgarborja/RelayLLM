import { ERROR_TEXT, type ChatStatus, type ErrorCode, type ReasoningSetting } from "@relayllm/protocol";
import type { ChatMessageRecord } from "./db.ts";
import { fmtInt, type UsageRecord } from "./metrics.ts";

/** Per-conversation preference; "auto" leaves it to the model. */
export type ReasoningPref = "auto" | ReasoningSetting;

/** What to send: nothing for auto, or when the current model doesn't support the preference. */
export function effectiveReasoning(pref: ReasoningPref | undefined, options: readonly ReasoningSetting[] | undefined): ReasoningSetting | undefined {
  return pref && pref !== "auto" && options?.includes(pref) ? pref : undefined;
}

/** Live view of a running request (never persisted). Times are performance.now(). */
export interface LiveGeneration {
  startedAt: number;
  acked: boolean;
  /** When the first text arrived here. */
  firstTextAt?: number;
  status?: ChatStatus;
  /** Last message of any kind from the worker. */
  lastContactAt: number;
  heartbeatSec: number;
}

const STATE_TEXT: Record<ChatStatus["state"], string> = {
  loading: "Loading model",
  prompt: "Processing prompt",
  thinking: "Thinking",
  answering: "Generating answer",
  finishing: "Finishing",
};

export interface LiveDescription {
  label: string;
  elapsedMs: number;
  tokens?: string;
  speed?: string;
  /** Anything unusual about progress or the connection. */
  note?: string;
}

/** Works without any status messages too (older workers): falls back to the text received. */
export function describeLive(live: LiveGeneration, m: Pick<ChatMessageRecord, "content" | "reasoning">, online: boolean, now: number): LiveDescription {
  const st = live.status;
  const label = st
    ? STATE_TEXT[st.state]
    : m.content
      ? STATE_TEXT.answering
      : m.reasoning
        ? STATE_TEXT.thinking
        : live.acked
          ? STATE_TEXT.prompt
          : "Queued";
  // Heartbeats are infrequent; in between, count the text that has arrived.
  const r = Math.max(st?.reasoningTokens ?? 0, Math.ceil((m.reasoning?.length ?? 0) / 4));
  const a = Math.max(st?.answerTokens ?? 0, Math.ceil(m.content.length / 4));
  const textMs = live.firstTextAt === undefined ? 0 : now - live.firstTextAt;
  const speed = textMs >= 1000 && r + a > 0 && st?.progress !== "quiet" ? (r + a) / (textMs / 1000) : (st?.tokensPerSecond ?? undefined);
  const tokens = [r ? `~${fmtInt(r)} reasoning` : "", a ? `~${fmtInt(a)} answer` : ""].filter(Boolean).join(" + ");
  const silent = now - live.lastContactAt;
  let note: string | undefined;
  if (!online) note = "Relays disconnected. Reconnecting; the worker keeps going.";
  else if (st && silent > live.heartbeatSec * 3000) note = `No heartbeat from the worker for ${fmtDuration(silent)}.`;
  else if (st?.progress === "quiet") note = `No new text for ${fmtDuration((st.sinceProgressMs ?? 0) + silent)}. The worker is connected.`;
  else if (st?.progress === "unknown" && st.elapsedMs > 20_000) note = "The worker is connected. The engine hasn't reported progress yet.";
  return {
    label,
    elapsedMs: now - live.startedAt,
    tokens: tokens ? `${tokens} tokens` : undefined,
    speed: speed !== undefined ? `~${speed.toFixed(1)} tok/s` : undefined,
    note,
  };
}

export function fmtDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`;
}

/** Why a reply failed. Never calls a token or context limit a timeout. */
export function describeFailure(code: ErrorCode | undefined, usage: UsageRecord | undefined): string {
  switch (usage?.detail) {
    case "inactivity":
      return "The engine stopped producing text, so the worker ended the request. The text so far was kept.";
    case "absolute_timeout":
      return "The request reached the worker's time limit. The text so far was kept.";
    case "context_full":
      return "The conversation doesn't fit in the model's context window. Start a new conversation, or load the model with a larger context.";
    case "stream_ended":
      return "The engine closed the connection before finishing. The text so far was kept.";
    case "worker_shutdown":
      return "The worker was shut down during this response. The text so far was kept.";
    default:
      return code ? ERROR_TEXT[code] : "The response failed.";
  }
}

/** Explanation for a reply cut off by a limit (finishReason "length"). */
export function describeTruncation(m: Pick<ChatMessageRecord, "content" | "reasoning" | "usage">): string {
  const u = m.usage;
  const empty = !m.content.trim();
  switch (u?.detail) {
    case "context_full":
      return empty
        ? "The model's context window filled up before it could answer. Start a new conversation, or load the model with a larger context."
        : "The model's context window filled up, so the answer is cut off.";
    case "response_size":
      return "The response reached the worker's size limit.";
    case "engine_limit":
      return "The engine stopped at a length limit of its own, below the worker's generation budget.";
    default: {
      const budget = u?.maxTokens ? ` (${fmtInt(u.maxTokens)} tokens)` : "";
      return empty
        ? `The generation budget${budget} was used up ${m.reasoning ? "by reasoning " : ""}before an answer was produced. Try turning reasoning off for this conversation, or ask the worker owner to raise the budget.`
        : `The generation budget${budget} was used up, so the answer is cut off.`;
    }
  }
}
