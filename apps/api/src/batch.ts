import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { RelayLLMError } from "./errors.ts";
import type { RelayLLM, RunRequest, RunResult } from "./types.ts";

export interface BatchItem {
  id: string;
  input: string;
}

export type BatchSettings = Omit<RunRequest, "id" | "input" | "signal" | "onText"> & { model: string };

/** A result line: `key` identifies the input and settings that produced it. */
export type BatchLine = RunResult & { key: string };

/** Going on would only repeat these for every remaining item. */
const FATAL = new Set(["unauthorized", "pending_approval", "model_unavailable", "unsupported", "unsupported_version", "no_response", "publish_failed", "cancelled"]);

const bad = (message: string) => new RelayLLMError("invalid_request", message);

/** .jsonl files hold one item per line; any other file is one item. */
export function readItems(files: string[]): BatchItem[] {
  const items: BatchItem[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (text.includes("\0")) throw bad(`${file} is not a text file.`);
    if (extname(file).toLowerCase() !== ".jsonl") {
      items.push({ id: basename(file), input: text });
      continue;
    }
    text.split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        throw bad(`${file}:${i + 1} is not valid JSON.`);
      }
      const o = (typeof v === "string" ? { input: v } : v) as { id?: unknown; input?: unknown } | null;
      if (!o || typeof o.input !== "string") throw bad(`${file}:${i + 1} needs an "input" string.`);
      if (o.id !== undefined && typeof o.id !== "string" && typeof o.id !== "number") throw bad(`${file}:${i + 1}: "id" must be a string or number.`);
      items.push({ id: String(o.id ?? `line-${i + 1}`), input: o.input });
    });
  }
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) throw bad(`Two items have the id "${it.id}".`);
    if (!it.input.trim()) throw bad(`Item "${it.id}" is empty.`);
    seen.add(it.id);
  }
  if (!items.length) throw bad("There is nothing to run.");
  return items;
}

export function itemKey(item: BatchItem, s: BatchSettings): string {
  const parts = [item.input, s.model, s.system ?? null, s.schema ?? null, s.reasoning ?? null, s.temperature ?? null, s.topP ?? null, s.maxTokens ?? null];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** Finished lines of an earlier run. Refuses files this command didn't write. */
export function readResults(path: string): BatchLine[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const out: BatchLine[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line) as BatchLine;
      if (typeof r.id === "string" && typeof r.ok === "boolean" && typeof r.key === "string") return void out.push(r);
    } catch {
      if (i === lines.length - 1 && out.length) return; // cut off by a crash
    }
    throw bad(`${path} exists and is not a result file. Choose another --out.`);
  });
  return out;
}

export async function runBatch(
  llm: Pick<RelayLLM, "run">,
  items: BatchItem[],
  settings: BatchSettings,
  o: { out?: string; write: (line: string) => void; signal?: AbortSignal; onProgress?: (done: number, r: RunResult) => void },
): Promise<{ succeeded: number; failed: number; skipped: number; notRun: number }> {
  const done = new Set<string>();
  if (o.out) {
    const key = new Map(items.map((it) => [it.id, itemKey(it, settings)]));
    const old = readResults(o.out);
    const stale = old.find((r) => r.ok && key.has(r.id) && key.get(r.id) !== r.key);
    if (stale) throw bad(`${o.out} already has a result for "${stale.id}" from a different text or settings. Choose another --out.`);
    // Keep finished results; failed items in this batch are run again.
    const keep = old.filter((r) => r.ok || !key.has(r.id));
    for (const r of keep) if (key.has(r.id)) done.add(r.id);
    if (existsSync(o.out)) {
      const tmp = `${o.out}.tmp`;
      writeFileSync(tmp, keep.map((r) => `${JSON.stringify(r)}\n`).join(""));
      renameSync(tmp, o.out);
    }
  }
  const total = { succeeded: 0, failed: 0, skipped: done.size, notRun: 0 };
  const todo = items.filter((it) => !done.has(it.id));
  for (const [i, it] of todo.entries()) {
    const r = await llm.run({ ...settings, id: it.id, input: it.input, signal: o.signal });
    const line = JSON.stringify({ ...r, key: itemKey(it, settings) } satisfies BatchLine);
    if (o.out) appendFileSync(o.out, `${line}\n`);
    else o.write(`${line}\n`);
    if (r.ok) total.succeeded++;
    else total.failed++;
    o.onProgress?.(done.size + i + 1, r);
    if (!r.ok && FATAL.has(r.error.code)) {
      total.notRun = todo.length - i - 1;
      break;
    }
  }
  return total;
}
