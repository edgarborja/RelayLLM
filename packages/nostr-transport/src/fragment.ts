import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { utf8Length } from "./wrap.ts";

/**
 * Bounded fragmentation for messages that do not fit in one relay event.
 *
 * A fragment is itself the content of a signed inner event:
 *   { "type": "frag", "fid": <id>, "i": <index>, "n": <count>, "sha256": <hex of full text>, "data": <slice> }
 *
 * Every fragment is individually authenticated and replay-checked by the
 * transport. The reassembled text must match sha256 and be from the same
 * sender as all of its fragments, within a deadline and size budget.
 */

export interface Fragment {
  type: "frag";
  fid: string;
  i: number;
  n: number;
  sha256: string;
  data: string;
}

export const sha256Hex = (s: string): string => bytesToHex(sha256(new TextEncoder().encode(s)));

/** Split text into code-point-safe slices of at most `maxBytes` UTF-8 bytes. */
export function splitUtf8(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const b = ch.length === 2 ? 4 : ch.charCodeAt(0) < 0x80 ? 1 : ch.charCodeAt(0) < 0x800 ? 2 : 3;
    if (curBytes + b > maxBytes && cur) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Returns the text unchanged if it fits in `maxBytes`, otherwise a list of
 * serialized fragments, each of which fits.
 */
export function fragmentText(text: string, maxBytes: number, fid: string): string[] {
  if (utf8Length(text) <= maxBytes) return [text];
  const hash = sha256Hex(text);
  // JSON escaping can at most double ASCII (\" and \\) and the envelope is small;
  // start at ~45% of the budget and shrink if a slice still doesn't fit.
  let slice = Math.floor(maxBytes * 0.45);
  for (;;) {
    const parts = splitUtf8(text, slice);
    const frags = parts.map((data, i) =>
      JSON.stringify({ type: "frag", fid, i, n: parts.length, sha256: hash, data } satisfies Fragment),
    );
    if (frags.every((f) => utf8Length(f) <= maxBytes)) return frags;
    slice = Math.floor(slice / 2);
    if (slice < 256) throw new Error("cannot fragment message");
  }
}

export function isFragment(v: unknown): v is Fragment {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    f.type === "frag" &&
    typeof f.fid === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/.test(f.fid) &&
    Number.isInteger(f.i) &&
    Number.isInteger(f.n) &&
    (f.n as number) >= 2 &&
    (f.i as number) >= 0 &&
    (f.i as number) < (f.n as number) &&
    typeof f.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(f.sha256) &&
    typeof f.data === "string"
  );
}

interface Pending {
  sender: string;
  n: number;
  sha256: string;
  parts: (string | undefined)[];
  received: number;
  bytes: number;
  deadline: number;
}

export interface ReassemblerLimits {
  maxFragments: number;
  maxTotalBytes: number;
  timeoutMs: number;
  maxPendingPerSender: number;
}

export const DEFAULT_REASSEMBLER_LIMITS: ReassemblerLimits = {
  maxFragments: 64,
  maxTotalBytes: 1_000_000,
  timeoutMs: 60_000,
  maxPendingPerSender: 4,
};

export type ReassembleResult =
  | { status: "partial" }
  | { status: "complete"; text: string }
  | { status: "rejected"; reason: string };

export class Reassembler {
  readonly #pending = new Map<string, Pending>();
  readonly #limits: ReassemblerLimits;

  constructor(limits: Partial<ReassemblerLimits> = {}) {
    this.#limits = { ...DEFAULT_REASSEMBLER_LIMITS, ...limits };
  }

  add(sender: string, frag: Fragment, now = Date.now()): ReassembleResult {
    this.#expire(now);
    const key = `${sender}:${frag.fid}`;
    let p = this.#pending.get(key);
    if (!p) {
      if (frag.n > this.#limits.maxFragments) return { status: "rejected", reason: "too many fragments" };
      let count = 0;
      for (const v of this.#pending.values()) if (v.sender === sender) count++;
      if (count >= this.#limits.maxPendingPerSender) return { status: "rejected", reason: "too many pending" };
      p = {
        sender,
        n: frag.n,
        sha256: frag.sha256,
        parts: new Array(frag.n),
        received: 0,
        bytes: 0,
        deadline: now + this.#limits.timeoutMs,
      };
      this.#pending.set(key, p);
    }
    if (frag.n !== p.n || frag.sha256 !== p.sha256) {
      this.#pending.delete(key);
      return { status: "rejected", reason: "inconsistent fragments" };
    }
    if (p.parts[frag.i] !== undefined) return { status: "partial" }; // duplicate
    p.bytes += frag.data.length;
    if (p.bytes > this.#limits.maxTotalBytes) {
      this.#pending.delete(key);
      return { status: "rejected", reason: "message too large" };
    }
    p.parts[frag.i] = frag.data;
    p.received++;
    if (p.received < p.n) return { status: "partial" };
    this.#pending.delete(key);
    const text = p.parts.join("");
    if (sha256Hex(text) !== p.sha256) return { status: "rejected", reason: "integrity check failed" };
    return { status: "complete", text };
  }

  #expire(now: number): void {
    for (const [k, p] of this.#pending) if (p.deadline < now) this.#pending.delete(k);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}
