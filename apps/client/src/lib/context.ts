import type { ChatMessage, Limits } from "@relayllm/protocol";
import type { ChatMessageRecord } from "./db.ts";

/**
 * Build the context sent to the worker from local history, respecting the
 * worker's advertised limits. Never truncates silently: returns how many
 * earlier messages were left out so the UI can say so.
 */
export function buildContext(
  history: ChatMessageRecord[],
  limits: Limits | undefined,
  systemPrompt?: string,
): { messages: ChatMessage[]; omitted: number; tooLarge: boolean } {
  const usable = history.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim() !== "" && m.status !== "error");
  const all: ChatMessage[] = usable.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const system: ChatMessage[] = systemPrompt?.trim() ? [{ role: "system", content: systemPrompt.trim() }] : [];

  const maxBytes = Math.floor((limits?.maxRequestBytes ?? 400_000) * 0.9); // envelope headroom
  const maxMessages = (limits?.maxMessages ?? 200) - system.length;
  const size = (msgs: ChatMessage[]) => new TextEncoder().encode(JSON.stringify(msgs)).length;

  let start = Math.max(0, all.length - maxMessages);
  while (start < all.length - 1 && size([...system, ...all.slice(start)]) > maxBytes) start++;
  // Don't start the context with an assistant turn.
  while (start < all.length - 1 && all[start]!.role === "assistant") start++;
  const messages = [...system, ...all.slice(start)];
  return { messages, omitted: start, tooLarge: size(messages) > maxBytes };
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 47)}…` : t || "New chat";
}
