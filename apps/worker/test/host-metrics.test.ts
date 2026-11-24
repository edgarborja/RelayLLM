import { describe, expect, it } from "vitest";
import { HostMetrics } from "@relayllm/protocol";
import { parseMacPressure, parseMeminfo, parsePsi, parseSwapUsage, parseVmStat, sampleHost } from "../src/host-metrics.ts";

describe("host metrics parsers", () => {
  it("computes macOS used memory like Activity Monitor (app + wired + compressed)", () => {
    const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    11067.
Pages active:                                 204182.
Pages inactive:                               199272.
Pages wired down:                             111012.
Pages purgeable:                                3973.
Anonymous pages:                              272736.
Pages occupied by compressor:                 481817.
`;
    expect(parseVmStat(vm)).toEqual({ pageSize: 16384, usedBytes: (272736 - 3973 + 111012 + 481817) * 16384 });
    expect(parseVmStat("garbage")).toBeNull();
  });

  it("parses swap usage and pressure levels", () => {
    expect(parseSwapUsage("total = 1024.00M  used = 575.19M  free = 448.81M  (encrypted)")).toEqual({
      total: 1024 * 1024 ** 2,
      used: 575.19 * 1024 ** 2,
    });
    expect(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({ total: 0, used: 0 });
    expect(parseMacPressure("1\n")).toBe("normal");
    expect(parseMacPressure("2")).toBe("warning");
    expect(parseMacPressure("4")).toBe("critical");
    expect(parseMacPressure("")).toBeNull();
  });

  it("parses Linux /proc/meminfo and PSI", () => {
    const mi = parseMeminfo("MemTotal:       16303428 kB\nMemFree:          812340 kB\nMemAvailable:    9120000 kB\nSwapTotal:       2097148 kB\nSwapFree:        2000000 kB\nHugePages_Total:       0\n");
    expect(mi.MemTotal).toBe(16303428 * 1024);
    expect(mi.MemAvailable).toBe(9120000 * 1024);
    expect(mi.HugePages_Total).toBe(0);
    expect(parsePsi("some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0")).toBe("normal");
    expect(parsePsi("some avg10=22.50 avg60=3.00 avg300=1.00 total=9\nfull avg10=1.00 avg60=0 avg300=0 total=1")).toBe("warning");
    expect(parsePsi("some avg10=40.00 avg60=3.00 avg300=1.00 total=9\nfull avg10=12.00 avg60=0 avg300=0 total=1")).toBe("critical");
    expect(parsePsi("")).toBeNull();
  });

  it("samples this machine into the protocol shape", async () => {
    const h = HostMetrics.parse(await sampleHost());
    expect(h.memTotalBytes).toBeGreaterThan(0);
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(h.memAvailableBytes).toBeGreaterThan(0);
      expect(h.memAvailableBytes!).toBeLessThanOrEqual(h.memTotalBytes!);
      expect(h.memUsedPercent).not.toBeNull();
    }
  });
});
