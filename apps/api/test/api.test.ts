import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { buildPairingUrl, hexToNpub, LocalSigner } from "@relayllm/nostr-transport";
import { schemaProblem } from "@relayllm/protocol";
import { createInvite } from "../../worker/src/access.ts";
import { makeHarness, type Harness } from "../../worker/test/harness.ts";
import { readItems, readResults, runBatch } from "../src/batch.ts";
import { connect } from "../src/client.ts";
import type { RelayLLM, RunResult } from "../src/types.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");
const TSX = join(import.meta.dirname, "../../../node_modules/.bin/tsx");
const exec = promisify(execFile);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function harness(...args: Parameters<typeof makeHarness>): Promise<Harness> {
  const h = await makeHarness(...args);
  cleanups.push(() => h.close());
  return h;
}
function user(h: Harness, authorized = true) {
  const sk = generateSecretKey();
  const signer = new LocalSigner(sk);
  if (authorized) h.config.access.users.push({ pubkey: signer.pubkey, addedAt: Date.now() });
  return { secretKey: nip19.nsecEncode(sk), worker: hexToNpub(h.worker.pubkey), relays: [h.relay.url], signer };
}
async function api(h: Harness, u = user(h)): Promise<RelayLLM> {
  const llm = await connect({ worker: u.worker, relays: u.relays, secretKey: u.secretKey, requestTimeoutMs: 3000 });
  cleanups.push(() => llm.close());
  return llm;
}
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "relayllm-api-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const model = "mock-llm-small";
const schema = {
  type: "object",
  properties: { translation: { type: "string" } },
  required: ["translation"],
  additionalProperties: false,
};
const good = () => JSON.stringify({ translation: "Dear Ana" });

describe("structured output", () => {
  it("passes the schema to the engine, turns reasoning off, and returns parsed JSON", async () => {
    const h = await harness({ provider: { reply: good, reasoningOptions: ["off", "on"] } });
    const llm = await api(h);
    expect(llm.structuredOutput).toBe(true);
    const r = await llm.run({ id: "a", model, system: "Translate", input: "Querida Ana", schema });
    expect(r).toMatchObject({ id: "a", ok: true, model, output: { translation: "Dear Ana" }, finish: "stop", attempts: 1 });
    const body = h.provider.chats[0]!.body;
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "output", strict: true, schema } });
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages).toEqual([{ role: "system", content: "Translate" }, { role: "user", content: "Querida Ana" }]);
  });

  it("refuses reasoning together with a schema, and leaves models without the control alone", async () => {
    const h = await harness({ provider: { reply: good, reasoningOptions: ["off", "on"] } });
    const r = await (await api(h)).run({ model, input: "x", schema, reasoning: "on" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_request" }, attempts: 1 });
    expect(h.provider.chats).toHaveLength(0);

    const plain = await harness({ provider: { reply: good } });
    expect((await (await api(plain)).run({ model, input: "x", schema })).ok).toBe(true);
    expect(plain.provider.chats[0]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("sends no response_format without a schema and returns the text", async () => {
    const h = await harness();
    expect(await (await api(h)).run({ model, input: "hi" })).toMatchObject({ ok: true, output: "Echo: hi" });
    expect(h.provider.chats[0]!.body).not.toHaveProperty("response_format");
  });

  it("retries once when the answer doesn't match, then reports it", async () => {
    let n = 0;
    const h = await harness({ provider: { reply: () => (n++ === 0 ? '{"wrong": 1}' : good()) } });
    expect(await (await api(h)).run({ model, input: "x", schema })).toMatchObject({ ok: true, attempts: 2 });

    const bad = await harness({ provider: { reply: () => "Sure! Here you go" } });
    const r = await (await api(bad)).run({ model, input: "x", schema });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_output" }, text: "Sure! Here you go", attempts: 2 });
  });

  it("is enforced by the worker and can be disabled by its owner", async () => {
    const h = await harness({ config: (c) => (c.limits.maxSchemaChars = 0) });
    const u = user(h);
    const llm = await api(h, u);
    expect(llm.structuredOutput).toBe(false);
    await expect(llm.run({ model, input: "x", schema })).rejects.toMatchObject({ code: "unsupported" });
    // A client that ignores the advertisement is still refused.
    const c = h.client(u.signer);
    const params = { responseFormat: { type: "json_schema" as const, schema } };
    await expect(c.chat({ model, messages: [{ role: "user", content: "x" }], params }).result).rejects.toMatchObject({ code: "invalid_request" });
    h.config.limits.maxSchemaChars = 16_000;
    const remote = { responseFormat: { type: "json_schema" as const, schema: { $ref: "http://169.254.169.254/x" } } };
    await expect(c.chat({ model, messages: [{ role: "user", content: "x" }], params: remote }).result).rejects.toMatchObject({ code: "invalid_request" });
    expect(h.provider.chats).toHaveLength(0);
  });

  it("bounds schemas", () => {
    expect(schemaProblem(schema, 1000)).toBeNull();
    expect(schemaProblem({ $ref: "#/$defs/a", $defs: { a: { type: "string" } } }, 1000)).toBeNull();
    expect(schemaProblem([], 1000)).toMatch(/object/);
    expect(schemaProblem(schema, 20)).toMatch(/longer/);
    expect(schemaProblem({ type: "string", maxLength: 1e9 }, 1000)).toMatch(/maxLength/);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) deep = { items: deep };
    expect(schemaProblem(deep, 100_000)).toMatch(/deep/);
    expect(schemaProblem({ enum: Array.from({ length: 3000 }, (_, i) => i) }, 100_000)).toMatch(/complex/);
  });
});

describe("running requests", () => {
  it("queues concurrent runs, so the per-user limit is never hit", async () => {
    const h = await harness({ provider: { tokenDelayMs: 20 } });
    const llm = await api(h);
    const rs = await Promise.all(["one", "two", "three"].map((input) => llm.run({ model, input })));
    expect(rs.map((r) => r.ok && r.output)).toEqual(["Echo: one", "Echo: two", "Echo: three"]);
    expect(rs.every((r) => r.attempts === 1)).toBe(true);
  });

  it("waits for a busy worker", async () => {
    const h = await harness({ provider: { tokenDelayMs: 100 } });
    const u = user(h);
    const llm = await api(h, u);
    const other = h.client(u.signer).chat({ model, messages: [{ role: "user", content: "a b c d e f g h" }] });
    await new Promise((r) => setTimeout(r, 400));
    const r = await llm.run({ model, input: "hi" });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBeGreaterThan(1);
    await other.result;
  });

  it("reports a cut-off answer with its partial text, without retrying", async () => {
    const h = await harness({ provider: { script: () => [{ answer: "partial" }, { finish: "length" }] } });
    expect(await (await api(h)).run({ model, input: "x" })).toMatchObject({ ok: false, error: { code: "truncated" }, text: "partial", attempts: 1 });
  });

  it("cancels on abort and stops the engine", async () => {
    const h = await harness({ provider: { script: () => [{ answer: "start " }, { hang: true }] } });
    const ac = new AbortController();
    const r = await (await api(h)).run({ model, input: "x", signal: ac.signal, onText: () => ac.abort() });
    expect(r).toMatchObject({ ok: false, error: { code: "cancelled" }, text: "start " });
    await expect.poll(() => h.provider.chats[0]!.aborted).toBe(true);
  });

  it("rejects unusable requests and unauthorized callers", async () => {
    const h = await harness();
    const llm = await api(h);
    await expect(llm.run({ model, input: " " })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(llm.run({ input: "x" })).rejects.toMatchObject({ code: "model_unavailable" });
    await expect(llm.run({ model, input: "x", schema: { type: "nonsense" } })).rejects.toMatchObject({ code: "invalid_schema" });
    await expect(api(h, user(h, false))).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("batch", () => {
  const items = [{ id: "a", input: "A" }, { id: "b", input: "B" }, { id: "c", input: "C" }];
  const fake = (fail: Record<string, string> = {}) => {
    const ran: string[] = [];
    return {
      ran,
      run: (async (q: { id: string; input: string }) => {
        ran.push(q.id);
        const base = { id: q.id, model, attempts: 1, ms: 1 };
        return fail[q.id] ? { ...base, ok: false, error: { code: fail[q.id]!, message: "m" } } : { ...base, ok: true, output: q.input, finish: "stop" };
      }) as unknown as RelayLLM["run"],
    };
  };
  const write = () => undefined;

  it("resumes: skips finished items, reruns failed ones, tolerates a cut-off last line", async () => {
    const out = join(tmp(), "out.jsonl");
    const first = fake({ b: "truncated" });
    expect(await runBatch(first, items, { model }, { out, write })).toEqual({ succeeded: 2, failed: 1, skipped: 0, notRun: 0 });
    writeFileSync(out, `${readFileSync(out, "utf8")}{"id":"z","o`);
    const second = fake();
    expect(await runBatch(second, items, { model }, { out, write })).toEqual({ succeeded: 1, failed: 0, skipped: 2, notRun: 0 });
    expect(second.ran).toEqual(["b"]);
    expect(readResults(out).map((r) => [r.id, r.ok]).sort()).toEqual([["a", true], ["b", true], ["c", true]]);
  });

  it("never overwrites other files or results from different settings", async () => {
    const dir = tmp();
    const other = join(dir, "letter.txt");
    writeFileSync(other, "Dear Ana\n");
    await expect(runBatch(fake(), items, { model }, { out: other, write })).rejects.toThrow(/not a result file/);
    expect(readFileSync(other, "utf8")).toBe("Dear Ana\n");
    const out = join(dir, "out.jsonl");
    await runBatch(fake(), items, { model, system: "one" }, { out, write });
    const before = readFileSync(out, "utf8");
    await expect(runBatch(fake(), items, { model, system: "two" }, { out, write })).rejects.toThrow(/different text or settings/);
    expect(readFileSync(out, "utf8")).toBe(before);
  });

  it("stops when every further item would fail the same way", async () => {
    const f = fake({ a: "no_response" });
    expect(await runBatch(f, items, { model }, { write })).toMatchObject({ failed: 1, notRun: 2 });
    expect(f.ran).toEqual(["a"]);
  });

  it("reads text files and JSONL, and reports bad input", () => {
    const dir = tmp();
    const file = (n: string, s: string) => (writeFileSync(join(dir, n), s), join(dir, n));
    expect(readItems([file("one.txt", "Hola"), file("l.jsonl", '{"id":7,"input":"x"}\n\n"y"\n')])).toEqual([
      { id: "one.txt", input: "Hola" },
      { id: "7", input: "x" },
      { id: "line-3", input: "y" },
    ]);
    expect(() => readItems([file("d.jsonl", '{"id":1,"input":"x"}\n{"id":1,"input":"y"}')])).toThrow(/Two items/);
    expect(() => readItems([file("e.jsonl", "{nope")])).toThrow(/e\.jsonl:1/);
    expect(() => readItems([file("f.docx", "PK\0")])).toThrow(/not a text file/);
  });
});

describe("CLI", () => {
  it("pairs with an invite, reports status, and runs a batch", async () => {
    const h = await harness({ provider: { reply: good }, config: (c) => (c.models.exposed = [model]) });
    const home = join(tmp(), "home");
    const dir = tmp();
    const run = (...args: string[]) => exec(TSX, [CLI, ...args], { env: { ...process.env, RELAYLLM_API_HOME: home }, timeout: 15_000 });
    const token = createInvite(h.config, 60);
    const link = buildPairingUrl("https://client.example/", { workerPubkey: h.worker.pubkey, relays: [h.relay.url], name: "T", invite: token });
    expect((await run("pair", link, "--label", "letters")).stderr).toContain("Paired as npub1");
    expect(statSync(join(home, "default.json")).mode & 0o777).toBe(0o600);
    expect(h.config.access.users.at(-1)!.label).toBe("letters");

    const status = JSON.parse((await run("status")).stdout);
    expect(status).toMatchObject({ worker: "Test Worker", structuredOutput: true, models: [{ id: model }] });
    expect(JSON.stringify(status)).not.toContain("nsec");

    writeFileSync(join(dir, "s.json"), JSON.stringify(schema));
    writeFileSync(join(dir, "1.txt"), "Querida Ana");
    writeFileSync(join(dir, "2.txt"), "Querido Luis");
    const b = await run("batch", join(dir, "1.txt"), join(dir, "2.txt"), "--schema", join(dir, "s.json"), "--system", "Translate");
    const lines = b.stdout.trim().split("\n").map((l) => JSON.parse(l) as RunResult);
    expect(lines.map((l) => [l.id, l.ok && l.output])).toEqual([
      ["1.txt", { translation: "Dear Ana" }],
      ["2.txt", { translation: "Dear Ana" }],
    ]);
    expect(b.stderr).toContain("2 done, 0 failed");
    await expect(run("run", "x", "--system", "missing.md")).rejects.toMatchObject({ code: 2 });
  });
});
