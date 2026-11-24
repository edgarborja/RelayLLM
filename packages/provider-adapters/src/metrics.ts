/**
 * Provider-neutral model and engine metrics.
 *
 * Every field is optional: undefined means the engine doesn't report it.
 * Adapters must never fill gaps with zeros or guesses, and must keep the
 * model's theoretical maximum context (`maxContext`) separate from the
 * window the engine actually allocated (`loadedContext`).
 */
export interface ModelRuntimeInfo {
  id: string;
  state: "loaded" | "not-loaded" | "unknown";
  /** Maximum context the model supports (training/architecture limit). */
  maxContext?: number;
  /** Context window currently configured or allocated by the engine. */
  loadedContext?: number;
  /** Memory used by the loaded model. */
  memoryBytes?: number;
  /** Portion of memoryBytes in GPU memory. */
  vramBytes?: number;
  /** Size of the weights on disk. */
  sizeBytes?: number;
  architecture?: string;
  quantization?: string;
  parameters?: string;
}

export interface EngineStats {
  /** Fraction 0–1 of KV cache in use. */
  kvCacheUsage?: number;
  requestsRunning?: number;
  requestsWaiting?: number;
}

/** What an adapter can report, so clients can say "not supported" rather than "unknown". */
export interface MetricsSupport {
  loadState: boolean;
  maxContext: boolean;
  loadedContext: boolean;
  memory: boolean;
  engineStats: boolean;
}

// ---------------------------------------------------------------- helpers

export const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

export const nonNeg = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Short, printable label from engine metadata (never forwarded unbounded). */
export const shortLabel = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[^\x20-\x7e]/g, "").trim();
  return s ? s.slice(0, 64) : undefined;
};

/**
 * Parse a fixed allowlist of samples from Prometheus text exposition format.
 * Values of the same metric (e.g. one per model or engine) are summed.
 */
export function parsePrometheus(text: string, names: readonly string[]): Map<string, number> {
  const wanted = new Set(names);
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([^\s]+)/.exec(line);
    if (!m || !wanted.has(m[1]!)) continue;
    const v = Number(m[3]);
    if (!Number.isFinite(v)) continue;
    out.set(m[1]!, (out.get(m[1]!) ?? 0) + v);
  }
  return out;
}
