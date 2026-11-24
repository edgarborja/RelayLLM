import { Agent, fetch as undiciFetch } from "undici";
import type { ErrorKind, InferenceEvent } from "./types.ts";

/**
 * fetch for inference requests. Node's built-in fetch gives up after 300 s
 * without response headers, or 300 s without body data, which kills healthy
 * reasoning models that stay silent. The worker enforces its own inactivity
 * and absolute timeouts, so those hidden ones are disabled here.
 */
let agent: Agent | undefined;
export const inferenceFetch = ((url: string, init?: RequestInit) => {
  agent ??= new Agent({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 1000 });
  return undiciFetch(url, { ...(init as object), dispatcher: agent });
}) as unknown as typeof fetch;

/** Reasoning settings a request may carry; "auto" is the absence of one. */
export const REASONING_SETTINGS = ["off", "on", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningSetting = (typeof REASONING_SETTINGS)[number];

/**
 * For engines that don't advertise reasoning support, the owner can declare it:
 *   toggle  chat_template_kwargs.enable_thinking (e.g. Qwen3 on vLLM)
 *   effort  reasoning_effort (e.g. gpt-oss)
 */
export const REASONING_MODES = ["toggle", "effort"] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export const isReasoningSetting = (v: unknown): v is ReasoningSetting => (REASONING_SETTINGS as readonly unknown[]).includes(v);

/** Classify engine error text. The text itself is never forwarded to clients. */
export function classifyEngineError(text: string): ErrorKind {
  return /context (length|window|size)|maximum context|max(imum)?_model_len|n_ctx|exceeds? .{0,40}context|prompt is too long|too many tokens/i.test(text)
    ? "context_overflow"
    : "bad_response";
}

/** Read at most `max` bytes of an error body, for classification only. */
export async function readBounded(res: Response, max = 8192): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let out = "";
  try {
    while (out.length < max) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  } catch {
    /* best effort */
  }
  await reader.cancel().catch(() => undefined);
  return out.slice(0, max);
}

/**
 * Some engines (no reasoning parser configured) put a leading
 * <think>…</think> block in the answer text. Route it to the reasoning stream
 * so it isn't shown as the answer. Only a block at the very start counts.
 */
export class ThinkSplitter {
  #state: "start" | "think" | "answer" = "start";
  #buf = "";

  push(text: string): InferenceEvent[] {
    if (this.#state === "answer") return text ? [{ type: "answer.delta", text }] : [];
    this.#buf += text;
    const out: InferenceEvent[] = [];
    if (this.#state === "start") {
      const t = this.#buf.trimStart();
      if (t.startsWith("<think>")) {
        this.#state = "think";
        this.#buf = t.slice(7);
      } else if ("<think>".startsWith(t)) {
        return out; // undecided (including only whitespace so far)
      } else {
        this.#state = "answer";
        out.push({ type: "answer.delta", text: this.#buf });
        this.#buf = "";
        return out;
      }
    }
    const end = this.#buf.indexOf("</think>");
    if (end >= 0) {
      if (end > 0) out.push({ type: "reasoning.delta", text: this.#buf.slice(0, end) });
      const rest = this.#buf.slice(end + 8).replace(/^\s+/, "");
      this.#state = "answer";
      this.#buf = "";
      if (rest) out.push({ type: "answer.delta", text: rest });
      return out;
    }
    // Hold back only what could be the start of a closing tag.
    let keep = 0;
    for (let n = Math.min(7, this.#buf.length); n > 0; n--) {
      if ("</think>".startsWith(this.#buf.slice(-n))) {
        keep = n;
        break;
      }
    }
    const emit = this.#buf.slice(0, this.#buf.length - keep);
    this.#buf = this.#buf.slice(this.#buf.length - keep);
    if (emit) out.push({ type: "reasoning.delta", text: emit });
    return out;
  }

  flush(): InferenceEvent[] {
    const text = this.#buf;
    this.#buf = "";
    if (!text) return [];
    return [{ type: this.#state === "think" ? "reasoning.delta" : "answer.delta", text }];
  }
}
