import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { MockProvider } from "@relayllm/test-utils";
import { parsePairingUrl } from "@relayllm/nostr-transport";

const CLI = join(import.meta.dirname, "../src/cli.ts");
const TSX = join(import.meta.dirname, "../../../node_modules/.bin/tsx");

let home: string;
let mock: MockProvider;
// Async on purpose: the mock provider lives in this process and must keep serving.
const exec = promisify(execFile);
const run = async (...args: string[]) =>
  (await exec(TSX, [CLI, ...args], { env: { ...process.env, RELAYLLM_HOME: home }, encoding: "utf8", timeout: 30_000 })).stdout;
const runFail = async (...args: string[]) => {
  try {
    await run(...args);
  } catch (e) {
    return e as { code: number; stderr: string };
  }
  throw new Error("expected command to fail");
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "relayllm-test-"));
  mock = await MockProvider.start();
});
afterAll(async () => {
  rmSync(home, { recursive: true, force: true });
  await mock.close();
});

describe("worker CLI", () => {
  it("initializes non-interactively with discovered models and owner-only files", async () => {
    const out = await run(
      "init",
      "--yes",
      "--provider",
      "lmstudio",
      "--url",
      mock.baseUrl,
      "--relays",
      "wss://relay.example,not a relay",
      "--client-url",
      "https://me.github.io/relayllm/",
      "--key-storage",
      "file",
      "--name",
      "Test",
    );
    expect(out).toMatch(/Worker npub: npub1/);
    expect(out).not.toMatch(/nsec1/);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.models.exposed).toEqual(["mock-llm-small", "mock-llm-large"]); // embeddings excluded
    expect(cfg.relays).toEqual(["wss://relay.example"]);
    expect(cfg.access.mode).toBe("private");
    expect(cfg.access.invites).toHaveLength(1);
    expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "secrets", "worker-nsec.secret")).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    // The config file never contains the private key.
    const skHex = Buffer.from(readFileSync(join(home, "secrets", "worker-nsec.secret"), "utf8"), "hex").toString("utf8");
    expect(skHex).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain(skHex);
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toMatch(/nsec1/);

    const link = out.split("\n").find((l) => l.startsWith("https://me.github.io/relayllm/?worker="))!;
    const info = parsePairingUrl(link)!;
    expect(info.relays).toEqual(["wss://relay.example"]);
    expect(info.invite).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("manages users, models, relays and access mode", async () => {
    const pk = getPublicKey(generateSecretKey());
    const npub = npubEncode(pk);
    await run("users", "add", npub, "--label", "phone");
    expect(await run("users")).toContain(`${npub}  phone`);
    await run("users", "remove", npub);
    expect(await run("users")).not.toContain(npub);
    expect((await runFail("users", "add", "npub1invalid")).code).toBe(1);

    await run("models", "disable", "mock-llm-large");
    await run("models", "add", "custom-model");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.models.exposed).toEqual(["mock-llm-small", "custom-model"]);
    expect(await run("models")).toMatch(/\[ \] mock-embed/);

    await run("relays", "add", "wss://second.example");
    expect((await run("relays")).trim().split("\n")).toEqual(["wss://relay.example", "wss://second.example"]);

    await run("access", "public");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).access.mode).toBe("public");
    await run("access", "private");
  });

  it("creates single-use invites and refuses non-loopback provider URLs", async () => {
    const out = await run("pair", "--invite", "--ttl", "30m");
    expect(out).toMatch(/#invite=/);
    const r = await runFail("provider", "set", "--url", "http://203.0.113.5:8000/v1");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not loopback/);
  });

  it("reports status without a running worker", async () => {
    const out = await run("status");
    expect(out).toMatch(/Provider: lmstudio .* reachable/);
    expect(out).toMatch(/Process:\s+not running/);
  });
});
