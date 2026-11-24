/**
 * System-instruction conventions.
 *
 * Clients send system instructions as leading `system` messages (the
 * OpenAI convention). Some engines or chat templates don't accept that role,
 * so the worker owner can pick another convention per provider or per model.
 * The client has no say in this choice.
 *
 *   system       leading { role: "system" } message (default)
 *   developer    leading { role: "developer" } message (newer OpenAI-style servers)
 *   user-prefix  instructions prepended to the first user message, for
 *                templates that reject the system role (e.g. some Gemma/Mistral builds)
 */
export const SYSTEM_PROMPT_STYLES = ["system", "developer", "user-prefix"] as const;
export type SystemPromptStyle = (typeof SYSTEM_PROMPT_STYLES)[number];

export interface WireMessage {
  role: string;
  content: string;
}

/** Leading system messages, joined, plus the rest of the conversation. */
export function splitSystem(messages: readonly WireMessage[]): { system: string; rest: WireMessage[] } {
  let i = 0;
  const parts: string[] = [];
  while (i < messages.length && messages[i]!.role === "system") {
    if (messages[i]!.content.trim()) parts.push(messages[i]!.content);
    i++;
  }
  return { system: parts.join("\n\n"), rest: messages.slice(i).map((m) => ({ role: m.role, content: m.content })) };
}

/**
 * Rewrite the leading system instructions for an engine's convention. Several
 * leading system messages are merged into one. The worker rejects requests
 * with system messages anywhere else, so none reach this point.
 */
export function applySystemPromptStyle(messages: readonly WireMessage[], style: SystemPromptStyle = "system"): WireMessage[] {
  const { system, rest } = splitSystem(messages);
  if (!system) return rest;
  switch (style) {
    case "system":
    case "developer":
      return [{ role: style, content: system }, ...rest];
    case "user-prefix": {
      const first = rest[0];
      if (first?.role === "user") return [{ role: "user", content: `${system}\n\n${first.content}` }, ...rest.slice(1)];
      return [{ role: "user", content: system }, ...rest];
    }
  }
}
