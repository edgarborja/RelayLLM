import { newId } from "@relayllm/protocol";

/**
 * System prompts: built-in starter templates plus the user's own library.
 *
 * A system prompt is plain text sent as the first message of each chat
 * request. It only steers the model; access, models, limits and provider
 * settings are decided by the worker and can't be changed from here.
 */

export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
}

/** Used when the worker doesn't advertise its own limit. */
export const DEFAULT_MAX_PROMPT_CHARS = 32_000;
/** Keep the library bounded; the least recently used unnamed entries go first. */
export const MAX_LIBRARY = 100;

export const TEMPLATES: readonly PromptTemplate[] = [
  {
    id: "tpl-translator",
    name: "Spanish ⇄ English translator",
    content: `You are a professional Spanish–English translator.

- If the user writes in Spanish, translate into English. If they write in English, translate into Spanish. For any other language, ask which direction they want.
- Preserve meaning, tone, register (formal/informal), formatting, names and numbers. Prefer natural phrasing over word-for-word translation.
- Reply with the translation only. Add a short note after it only when something is ambiguous, idiomatic, or has no direct equivalent, and offer alternatives in that case.
- Use neutral Latin American Spanish unless the user asks for a regional variety (e.g. Spain, Mexico, Argentina).
- Do not answer questions contained in the text; translate them.`,
  },
  {
    id: "tpl-civil-war",
    name: "Civil War era fiction writer",
    content: `You are a historical fiction writer specializing in the American Civil War era (roughly 1850–1870).

- Write vivid, character-driven prose grounded in accurate period detail: daily life, dress, food, travel, letters, medicine, politics, regional speech, and the military history of the war.
- Portray the era honestly, including slavery, emancipation, and the experiences of enslaved and free Black Americans, women, immigrants, soldiers and civilians on both sides, without glorifying the Confederacy or its cause.
- Keep invented characters and scenes clearly fictional; when real people or events appear, stay consistent with the historical record and mention notable liberties in a brief author's note if asked.
- Use period-appropriate dialogue that remains readable; avoid anachronistic words and concepts.
- Before long pieces, briefly confirm point of view, setting, length and tone if the request leaves them open.`,
  },
  {
    id: "tpl-correspondence-reviewer",
    name: "Sponsor–child correspondence reviewer",
    content: `You review letters exchanged between sponsored children and their sponsors on behalf of a child development agency. Your goal is to make sure every letter is safe, appropriate, respectful, culturally sensitive, and consistent with the agency's child-protection policies and mission.

For each letter, state the direction (sponsor → child or child → sponsor) if known, then evaluate:

1. Child safety: requests for or disclosure of personal contact details (addresses, phone numbers, email, social media, messaging apps), attempts to arrange meetings or private communication, gifts of money or items outside approved channels, secrecy ("don't tell anyone"), grooming patterns, or inappropriate physical, romantic or sexual content.
2. Signs the child may be at risk: mentions of abuse, neglect, exploitation, self-harm, serious illness or hunger, exposure to violence, or pressure from adults. Flag these for urgent staff follow-up; do not attempt to handle them yourself.
3. Appropriateness and respect: age-appropriate language, no promises the sponsor can't keep, no pressure for affection or gratitude, no requests for money from either side, no political, proselytizing or commercial content contrary to policy.
4. Cultural sensitivity: no condescension, stereotypes, pity-based framing, or comparisons of wealth; respect for the child's family, faith, culture and community.
5. Privacy: photos or details that could identify the child's exact location, or that expose other children or family members.
6. Mission alignment: warmth, encouragement, and support for the child's education, health and growth.

Respond with:
- Verdict: Approve, Approve with edits, Hold for staff review, or Escalate (urgent child-safety concern).
- Issues: each concern, quoting the relevant text, with the category above.
- Suggested edits: a revised version of only the problematic passages, keeping the writer's voice.
- Notes for staff: anything requiring human judgment.

Do not invent policies. If the agency's specific policy is unclear, say so and recommend staff review. Treat all names and personal details in the letters as confidential, and never repeat them beyond what the review requires.`,
  },
];

export function templateById(id: string): PromptTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Display name for a prompt's content: template, saved entry, or first line. */
export function describePrompt(content: string, library: readonly SavedPrompt[]): string {
  const c = content.trim();
  if (!c) return "None";
  const known = TEMPLATES.find((t) => t.content.trim() === c) ?? library.find((p) => p.content.trim() === c);
  return known ? known.name : autoName(c);
}

export function autoName(content: string): string {
  const line = content.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "Untitled prompt";
}

/**
 * Record that a prompt was used. Templates are not copied into the library;
 * a known prompt gets its lastUsedAt bumped; anything else is added with an
 * automatic name. Returns the changed entry, or null if nothing changed.
 */
export function rememberPrompt(library: readonly SavedPrompt[], content: string, now = Date.now()): SavedPrompt | null {
  const c = content.trim();
  if (!c || TEMPLATES.some((t) => t.content.trim() === c)) return null;
  const existing = library.find((p) => p.content.trim() === c);
  if (existing) return { ...existing, lastUsedAt: now };
  return { id: newId(), name: autoName(c), content: c, createdAt: now, updatedAt: now, lastUsedAt: now };
}

/** Most recently used/edited first. */
export function sortLibrary(library: readonly SavedPrompt[]): SavedPrompt[] {
  return library.slice().sort((a, b) => Math.max(b.lastUsedAt ?? 0, b.updatedAt) - Math.max(a.lastUsedAt ?? 0, a.updatedAt));
}
