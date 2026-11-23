/**
 * Structured logger. Callers pass metadata only — prompts, responses and
 * secrets must never be logged. As a guard, values under suspicious keys are
 * redacted.
 */
export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT = /nsec|secret|key|token|password|content|prompt|message[s]?$|authorization/i;

function fmt(meta?: Record<string, unknown>): string {
  if (!meta) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    const raw = REDACT.test(k) && typeof v === "string" ? "[redacted]" : typeof v === "string" ? v : JSON.stringify(v);
    // Values may originate from remote users: strip control chars (ANSI escapes etc.).
    const val = String(raw).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200);
    parts.push(`${k}=${val}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function createLogger(level: Level = (process.env.RELAYLLM_LOG as Level) || "info", out = console): Logger {
  const min = ORDER[level] ?? 20;
  const line = (l: Level, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[l] < min) return;
    const s = `${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} ${msg}${fmt(meta)}`;
    if (l === "error" || l === "warn") out.error(s);
    else out.log(s);
  };
  return {
    debug: (m, x) => line("debug", m, x),
    info: (m, x) => line("info", m, x),
    warn: (m, x) => line("warn", m, x),
    error: (m, x) => line("error", m, x),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
