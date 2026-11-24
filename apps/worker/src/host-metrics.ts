import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import type { HostMetrics } from "@relayllm/protocol";

/**
 * Read-only machine memory statistics. Only a fixed set of sources is ever
 * read: Node's os module, /proc/meminfo and /proc/pressure/memory on Linux,
 * and two fixed commands on macOS (absolute paths, fixed arguments, no shell).
 * Nothing here takes input from clients.
 */

export type HostSampler = () => Promise<HostMetrics>;

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/usr/sbin:/bin:/sbin", LC_ALL: "C" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

/** macOS vm_stat → bytes used the way Activity Monitor counts "Memory Used". */
export function parseVmStat(text: string): { pageSize: number; usedBytes: number } | null {
  const ps = /page size of (\d+) bytes/.exec(text);
  if (!ps) return null;
  const pageSize = Number(ps[1]);
  const pages = (label: string): number | undefined => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  const anonymous = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable") ?? 0;
  if (wired === undefined || compressed === undefined) return null;
  // App memory (anonymous minus purgeable) + wired + compressed.
  const app = anonymous !== undefined ? Math.max(0, anonymous - purgeable) : (pages("Pages active") ?? 0);
  return { pageSize, usedBytes: (app + wired + compressed) * pageSize };
}

/** "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)" */
export function parseSwapUsage(text: string): { total: number; used: number } | null {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 } as const;
  const get = (k: string) => {
    const m = new RegExp(`${k} = ([\\d.]+)([KMGT])`).exec(text);
    return m ? Number(m[1]) * unit[m[2] as keyof typeof unit] : undefined;
  };
  const total = get("total");
  const used = get("used");
  return total !== undefined && used !== undefined ? { total, used } : null;
}

/** kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical. */
export function parseMacPressure(text: string): HostMetrics["pressure"] {
  const n = Number(text.trim());
  return n === 1 ? "normal" : n === 2 ? "warning" : n === 4 ? "critical" : null;
}

/** /proc/meminfo values in bytes. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (m) out[m[1]!] = Number(m[2]) * (line.includes("kB") ? 1024 : 1);
  }
  return out;
}

/**
 * Linux PSI (/proc/pressure/memory). Thresholds on the 10 s averages:
 * any stall ≥ 10% → warning; full stall ≥ 5% → critical.
 */
export function parsePsi(text: string): HostMetrics["pressure"] {
  const avg = (kind: string) => {
    const m = new RegExp(`^${kind} avg10=([\\d.]+)`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const some = avg("some");
  const full = avg("full");
  if (some === undefined) return null;
  if ((full ?? 0) >= 5) return "critical";
  return some >= 10 ? "warning" : "normal";
}

const pct = (used: number, total: number) => Math.min(100, Math.max(0, Math.round((used / total) * 1000) / 10));

export const sampleHost: HostSampler = async () => {
  const at = Date.now();
  const total = os.totalmem();
  const base: HostMetrics = {
    at,
    platform: "other",
    memTotalBytes: total || null,
    memAvailableBytes: null,
    memUsedPercent: null,
    swapTotalBytes: null,
    swapUsedBytes: null,
    pressure: null,
  };

  if (process.platform === "darwin") {
    const [vm, swap, pressure] = await Promise.allSettled([
      run("/usr/bin/vm_stat", []),
      run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
      run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    ]);
    const used = vm.status === "fulfilled" ? parseVmStat(vm.value) : null;
    const sw = swap.status === "fulfilled" ? parseSwapUsage(swap.value) : null;
    return {
      ...base,
      platform: "macos",
      memAvailableBytes: used ? Math.max(0, total - used.usedBytes) : null,
      memUsedPercent: used ? pct(used.usedBytes, total) : null,
      swapTotalBytes: sw?.total ?? null,
      swapUsedBytes: sw?.used ?? null,
      pressure: pressure.status === "fulfilled" ? parseMacPressure(pressure.value) : null,
    };
  }

  if (process.platform === "linux") {
    const [mem, psi] = await Promise.allSettled([readFile("/proc/meminfo", "utf8"), readFile("/proc/pressure/memory", "utf8")]);
    const mi = mem.status === "fulfilled" ? parseMeminfo(mem.value) : {};
    const t = mi.MemTotal ?? total;
    const avail = mi.MemAvailable;
    return {
      ...base,
      platform: "linux",
      memTotalBytes: t || null,
      memAvailableBytes: avail ?? null,
      memUsedPercent: avail !== undefined && t ? pct(t - avail, t) : null,
      swapTotalBytes: mi.SwapTotal ?? null,
      swapUsedBytes: mi.SwapTotal !== undefined && mi.SwapFree !== undefined ? mi.SwapTotal - mi.SwapFree : null,
      pressure: psi.status === "fulfilled" ? parsePsi(psi.value) : null,
    };
  }

  // Windows (and others): os.freemem() reports available physical memory.
  const free = os.freemem();
  return {
    ...base,
    platform: process.platform === "win32" ? "windows" : "other",
    memAvailableBytes: free,
    memUsedPercent: total ? pct(total - free, total) : null,
  };
};
