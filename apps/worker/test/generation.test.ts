import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatComplete, envelope, type ChatStatus } from "@relayllm/protocol";
import type { ChatCallbacks, WorkerClient } from "@relayllm/nostr-transport";
import { MockRelay, type MockStep } from "@relayllm/test-utils";
import { defaultConfig, loadConfig, type Config } from "../src/config.ts";
import { completeUsage } from "../src/gateway.ts";
import { connected, makeHarness, sleep, waitFor, type Harness } from "./harness.ts";

let open: (Harness | MockRelay)[] = [];
afterEach(async () => {
  for (const h of open) await h.close();
  open = [];
});

/** Timeouts are scaled down: 120 s inactivity → 0.6 s, 10 s heartbeat → 0.1 s. */
async function setup(script: (m: { role: string; content: string }[]) => Iterable<MockStep>, cfg: (c: Config) => void = () => {}, extra: Parameters<typeof makeHarness>[0] = {}) {
  const h = await makeHarness({
    ...extra,
    provider: { script, reasoningOptions: ["off", "on"], ...extra.provider },
    config: (c) => {
      c.limits.inactivityTimeoutSec = 0.6;
      c.limits.heartbeatSec = 0.1;
      cfg(c);
    },
  });
  open.unshift(h);
  const c = h.client(h.newUser());
  await connected(c.pool);
  return { h, c };
}
const start = (c: WorkerClient, cb: ChatCallbacks = {}, params?: object) => c.chat({ model: "mock-llm-small", messages: [{ role: "user", content: "q" }], params }, cb);

function* thinking(n: number, ms: number): Generator<MockStep> {
  for (let i = 0; i < n; i++) {
    yield { reasoning: `step ${i}. ` };
    yield { wait: ms };
  }
}

describe("long-running reasoning", () => {
  it("lets reasoning run far past the inactivity timeout while it makes progress", async () => {
    const { c } = await setup(function* () {
      yield* thinking(20, 120); // 2.4 s = 4x the inactivity timeout
      yield { answer: "done" };
      yield { finish: "stop" };
    });
    const statuses: ChatStatus[] = [];
    let answeredAt = -1;
    const r = await start(c, { onStatus: (s) => statuses.push(s), onUpdate: (u) => u.content && answeredAt < 0 && (answeredAt = statuses.length) }).result;
    expect(r).toMatchObject({ finishReason: "stop", content: "done", incomplete: false });
    expect(r.reasoning).toContain("step 19.");
    // Thinking was visible to the client before the first answer text.
    expect(statuses.slice(0, answeredAt).some((s) => s.state === "thinking" && s.progress === "active")).toBe(true);
    expect(r.usage!.firstReasoningMs!).toBeLessThan(r.usage!.firstAnswerMs!);
    expect(r.usage!.inferenceMs!).toBeGreaterThan(2000);
    expect(r.timing.ackMs!).toBeLessThan(r.timing.totalMs);
  });

  it("does not kill an engine that exposes no progress, and reports it as unknown", async () => {
    const { c } = await setup(function* () {
      yield { wait: 2000 }; // silent for >3x the inactivity timeout
      yield { answer: "finally" };
      yield { finish: "stop" };
    });
    const statuses: ChatStatus[] = [];
    const r = await start(c, { onStatus: (s) => statuses.push(s) }).result;
    expect(r).toMatchObject({ finishReason: "stop", content: "finally" });
    const silent = statuses.filter((s) => s.sinceProgressMs === null);
    expect(silent.length).toBeGreaterThan(5);
    expect(silent.every((s) => s.progress === "unknown" && s.state === "prompt" && s.answerTokens === null && s.reasoningTokens === null)).toBe(true);
    expect(r.usage!.reasoningTokens).toBeUndefined(); // unavailable, not invented
  });

  it("heartbeats and keep-alives do not count as progress: a stall after output is stopped", async () => {
    const { h, c } = await setup(function* () {
      yield { reasoning: "thinking" };
      yield { answer: "partial answer" };
      for (let i = 0; i < 100; i++) {
        yield { keepAlive: true };
        yield { wait: 100 };
      }
    });
    const statuses: ChatStatus[] = [];
    const t0 = performance.now();
    const r = await start(c, { onStatus: (s) => statuses.push(s) }).result;
    expect(r).toMatchObject({ finishReason: "timeout", errorCode: "timeout", content: "partial answer" });
    expect(r.usage!.detail).toBe("inactivity");
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(statuses.filter((s) => (s.sinceProgressMs ?? 0) > 200).length).toBeGreaterThan(1); // heartbeats kept coming
    await waitFor(() => h.provider.chats[0]!.aborted);
  });

  it("enforces the absolute timeout in the worker, even with steady progress", async () => {
    const { h, c } = await setup(() => thinking(1000, 50), (cfg) => (cfg.limits.requestTimeoutSec = 1));
    const r = await start(c).result;
    expect(r.finishReason).toBe("timeout");
    expect(r.usage!.detail).toBe("absolute_timeout");
    expect(r.reasoning).toContain("step 5.");
    await waitFor(() => h.provider.chats[0]!.aborted);
    // ...with no client around either.
    const { c: c2, h: h2 } = await setup(() => thinking(1000, 50), (cfg) => (cfg.limits.requestTimeoutSec = 1));
    start(c2).result.catch(() => undefined);
    await waitFor(() => h2.provider.chats.length === 1);
    c2.stop();
    await waitFor(() => h2.provider.chats[0]!.aborted, 3000);
  });

  it("limits status traffic", async () => {
    const { c } = await setup(
      function* () {
        for (let i = 0; i < 30; i++) {
          yield { reasoning: "r" };
          yield { wait: 10 };
          yield { answer: "a" };
          yield { wait: 10 };
        }
        yield { finish: "stop" };
      },
      (cfg) => (cfg.limits.heartbeatSec = 10),
    );
    let n = 0;
    await start(c, { onStatus: () => n++ }).result;
    expect(n).toBeLessThanOrEqual(3); // 60 state flips in 0.6 s
  });
});

describe("cancellation", () => {
  const endless = function* (): Generator<MockStep> {
    yield* thinking(5, 20);
    for (let i = 0; i < 2000; i++) {
      yield { answer: `w${i} ` };
      yield { wait: 20 };
    }
  };

  it("stops during thinking, confirms, and frees the slot at once", async () => {
    const { h, c } = await setup(() => thinking(500, 20));
    let seen = "";
    const a = start(c, { onUpdate: (u) => (seen = u.reasoning) });
    await waitFor(() => seen.length > 0);
    const cancel = a.cancel();
    const r = await a.result;
    expect(r).toMatchObject({ finishReason: "cancelled", content: "", reasoning: seen });
    expect(await cancel).toBe("confirmed");
    await waitFor(() => h.provider.chats[0]!.aborted);
    expect(h.worker.gateway.activeCount).toBe(0);
    // Repeating it is safe.
    expect(await a.cancel()).toBe("confirmed");
    // perUserConcurrent is 1: a new request is accepted immediately.
    const b = start(c);
    await waitFor(() => h.provider.chats.length === 2);
    await b.cancel();
  });

  it("stops during the answer and keeps exactly what was shown", async () => {
    const { h, c } = await setup(endless);
    let seen = "";
    const a = start(c, { onUpdate: (u) => (seen = u.content) });
    await waitFor(() => seen.length > 20);
    const atStop = seen;
    const cancel = a.cancel();
    const r = await a.result;
    expect(r).toMatchObject({ finishReason: "cancelled", content: atStop, incomplete: false });
    expect(await cancel).toBe("confirmed");
    await sleep(300);
    expect(seen).toBe(atStop); // no chunks accepted after Stop
    const sent = h.provider.chats[0]!.tokensSent;
    await sleep(200);
    expect(h.provider.chats[0]!.tokensSent).toBe(sent);
  });

  it("is limited to the user's own request", async () => {
    const { h, c } = await setup(endless);
    const a = start(c);
    await waitFor(() => (h.provider.chats[0]?.tokensSent ?? 0) > 5);
    const other = h.client(h.newUser());
    await connected(other.pool);
    expect(await other.cancelRequest(a.id)).toBe("finished"); // "nothing of yours is running"
    await sleep(200);
    expect(h.provider.chats[0]!.aborted).toBe(false);
    expect(await a.cancel()).toBe("confirmed");
  });

  it("says so when the worker can't confirm", async () => {
    const { h, c } = await setup(endless);
    const c2 = h.client(h.newUser(), { cancelTimeoutMs: 150 });
    await connected(c2.pool);
    let seen = "";
    const a = start(c2, { onUpdate: (u) => (seen = u.content) });
    await waitFor(() => seen.length > 0);
    h.worker.pool.close(); // unreachable
    const cancel = a.cancel();
    expect((await a.result).content).toBe(seen); // partial answer kept regardless
    expect(await cancel).toBe("unconfirmed");
    void c;
  });

  it("wins when it overtakes the request it cancels", async () => {
    const { h } = await setup(endless);
    const u = h.newUser();
    const { endpoint, replies, pool } = h.raw(u);
    await connected(pool);
    const msg = envelope({ type: "chat.start" as const, model: "mock-llm-small", messages: [{ role: "user" as const, content: "x" }] });
    await endpoint.send(h.worker.pubkey, envelope({ type: "chat.cancel" as const, target: msg.id }));
    await waitFor(() => replies.some((r) => r.type === "chat.cancel.result" && r.status === "not_found"));
    await endpoint.send(h.worker.pubkey, msg);
    await waitFor(() => replies.some((r) => r.type === "chat.complete" && r.finishReason === "cancelled"));
    expect(h.provider.chats).toHaveLength(0);
  });
});

describe("token limits", () => {
  const usage = (completion: number, reasoning: number) => ({ usage: { prompt_tokens: 10, completion_tokens: completion, completion_tokens_details: { reasoning_tokens: reasoning } } });
  const small = (c: Config) => (c.limits.maxTokens = 300);

  it("budget exhausted while thinking: reported as such, not as a timeout", async () => {
    const { c } = await setup(
      function* () {
        yield { reasoning: "thinking a lot" };
        yield { finish: "length" };
        yield usage(299, 299);
      },
      small,
    );
    const r = await start(c).result;
    expect(r).toMatchObject({ finishReason: "length", content: "", errorCode: undefined });
    expect(r.usage).toMatchObject({ detail: "token_budget", maxTokens: 300, reasoningTokens: 299, answerTokens: 0, completionTokens: 299, contextWindow: 4096 });
  });

  it("budget exhausted during the answer keeps the partial answer and doesn't double-count", async () => {
    const { h, c } = await setup(
      function* () {
        yield { reasoning: "brief" };
        yield { answer: "The first part" };
        yield { finish: "length" };
        yield usage(300, 120);
      },
      small,
    );
    const r = await start(c).result;
    expect(r).toMatchObject({ finishReason: "length", content: "The first part" });
    expect(r.usage).toMatchObject({ detail: "token_budget", completionTokens: 300, reasoningTokens: 120, answerTokens: 180 });
    expect(r.usage!.sources).toEqual({ prompt: "provider", completion: "provider", reasoning: "provider", answer: "provider" });
    expect(h.provider.chats).toHaveLength(1); // never continued on its own
  });

  it("tells context exhaustion and engine errors apart", async () => {
    const full = await setup(function* () {
      yield { answer: "x" };
      yield { finish: "length" };
      yield { usage: { prompt_tokens: 4000, completion_tokens: 96 } };
    });
    expect((await start(full.c).result).usage!.detail).toBe("context_full");
    const over = await setup(() => [{ error: "greater than the context length" }]);
    expect(await start(over.c).result).toMatchObject({ finishReason: "error", errorCode: "too_large", usage: { detail: "context_full" } });
    const cut = await setup(() => [{ answer: "half an ans" }, { wait: 100 }, { drop: true }]);
    expect(await start(cut.c).result).toMatchObject({ finishReason: "error", content: "half an ans", usage: { detail: "stream_ended" } });
  });

  it("accounts for engines that count differently", () => {
    const base = { messages: [{ content: "x".repeat(40) }], startedAt: 0, firstReasoningAt: 10, firstAnswerAt: 20, endedAt: 1020 };
    // Reasoning outside completion_tokens: added once.
    expect(completeUsage({ ...base, reported: { promptTokens: 5, completionTokens: 20, reasoningTokens: 100 }, reasoningChars: 400, answerChars: 80 })).toMatchObject({ completionTokens: 120, answerTokens: 20 });
    // Total only: split is estimated and says so.
    expect(completeUsage({ ...base, reported: { promptTokens: 5, completionTokens: 100 }, reasoningChars: 300, answerChars: 100 })).toMatchObject({
      reasoningTokens: 75,
      answerTokens: 25,
      sources: { completion: "provider", reasoning: "estimated", answer: "estimated" },
    });
    // Nothing reported.
    expect(completeUsage({ ...base, reasoningChars: 0, answerChars: 80 })).toMatchObject({ source: "estimated", completionTokens: 20, answerTokens: 20, reasoningTokens: undefined });
  });
});

describe("reasoning settings", () => {
  const quick = (): MockStep[] => [{ answer: "ok" }, { finish: "stop" }];

  it("advertises and applies them; auto sends nothing", async () => {
    const { h, c } = await setup(quick);
    expect((await c.listModels())[0]!.reasoningOptions).toEqual(["off", "on"]);
    await start(c, {}, { reasoning: "off" }).result;
    await start(c).result;
    expect(h.provider.chats.map((x) => x.body.reasoning_effort)).toEqual(["none", undefined]);
    expect((await c.serverInfo()).limits).toMatchObject({ requestTimeoutSec: 1800, maxTokens: 16384 });
  });

  it("refuses settings the model doesn't support", async () => {
    const { h, c } = await setup(quick, undefined, { provider: { reasoningOptions: undefined } });
    expect((await c.listModels())[0]!.reasoningOptions).toEqual([]);
    await expect(start(c, {}, { reasoning: "off" }).result).rejects.toMatchObject({ code: "invalid_request" });
    expect(h.provider.chats).toHaveLength(0);
    expect((await start(c).result).content).toBe("ok");
  });
});

describe("transport health", () => {
  const script = function* (): Generator<MockStep> {
    yield* thinking(10, 60);
    for (let i = 0; i < 30; i++) {
      yield { answer: `w${i} ` };
      yield { wait: 20 };
    }
    yield { finish: "stop" };
  };
  const full = Array.from({ length: 30 }, (_, i) => `w${i} `).join("");

  it("copes with duplicated, delayed and reordered messages, including status", async () => {
    const relay = await MockRelay.start({ transform: (e) => [e, e], deliveryDelayMs: () => Math.random() * 200 });
    const { h, c } = await setup(script, undefined, { relayInstance: relay });
    open.push(relay);
    const ns: number[] = [];
    const r = await start(c, { onStatus: (s) => ns.push(s.n) }).result;
    expect(r).toMatchObject({ content: full, incomplete: false, finishReason: "stop" });
    expect(ns).toEqual([...ns].sort((a, b) => a - b)); // late ones dropped
    expect(new Set(ns).size).toBe(ns.length);
    expect(h.provider.chats).toHaveLength(1);
  });

  it("survives repeated disconnections during thinking and answering", async () => {
    const { h, c } = await setup(script);
    const a = start(c);
    await waitFor(() => (h.provider.chats[0]?.tokensSent ?? 0) > 3);
    h.relay.dropAll();
    await waitFor(() => (h.provider.chats[0]?.tokensSent ?? 0) > 20);
    h.relay.dropAll();
    expect(await a.result).toMatchObject({ content: full, incomplete: false, finishReason: "stop" });
  }, 15_000);

  it("recovers a lost tail from the delta count in heartbeats", async () => {
    let key = "";
    let dropped = 0;
    const relay = await MockRelay.start({ transform: (e) => (key && dropped < 3 && e.tags.some((t) => t[1] === key) && ++dropped ? "drop" : undefined) });
    const { c } = await setup(
      function* () {
        yield { answer: "first " };
        yield { wait: 300 };
        yield { answer: "second" };
        yield { wait: 2000 };
        yield { finish: "stop" };
      },
      (cfg) => (cfg.limits.inactivityTimeoutSec = 10),
      { relayInstance: relay },
    );
    open.push(relay);
    let text = "";
    const t0 = performance.now();
    const a = start(c, { onUpdate: (u) => ((text = u.content), (key ||= c.sessionPubkey)) });
    await waitFor(() => text === "first second", 2000); // well before the engine finishes
    expect(performance.now() - t0).toBeLessThan(2000);
    expect((await a.result).incomplete).toBe(false);
  });

  it("gives up on a vanished worker by its missing heartbeats, keeping partial text", async () => {
    const { h } = await setup(() => thinking(500, 20));
    const c = h.client(h.newUser(), { lostContactMs: 600 });
    await connected(c.pool);
    let seen = "";
    const a = start(c, { onUpdate: (u) => (seen = u.reasoning) });
    a.result.catch(() => undefined);
    await waitFor(() => seen.length > 0);
    h.worker.pool.close(); // killed: no goodbye
    await expect(a.result).rejects.toMatchObject({ code: "no_response" });
    expect(seen).toContain("step 0.");
  });

  it("stays compatible with clients that predate these fields", () => {
    const msg = envelope({ type: "chat.complete" as const, re: "x".repeat(22), deltaCount: 0, finishReason: "stop" as const, contentLength: 0, usage: { promptTokens: 1, somethingNew: true, detail: "from_the_future" as never } });
    const p = ChatComplete.parse(msg);
    expect(p.usage).toEqual({ promptTokens: 1, detail: undefined });
  });
});

describe("config migration", () => {
  it("raises the old spelled-out defaults once and keeps owner changes", () => {
    const write = (limits: object) => {
      const dir = mkdtempSync(join(tmpdir(), "relayllm-"));
      const cfg = defaultConfig({ keyStorage: "file" }) as unknown as { limits: object };
      writeFileSync(join(dir, "config.json"), JSON.stringify({ ...cfg, limits }));
      return loadConfig(dir).limits;
    };
    expect(write({ requestTimeoutSec: 300, maxTokens: 8192 })).toMatchObject({ requestTimeoutSec: 1800, maxTokens: 16384, inactivityTimeoutSec: 120, heartbeatSec: 10 });
    expect(write({ requestTimeoutSec: 600, maxTokens: 2000 })).toMatchObject({ requestTimeoutSec: 600, maxTokens: 2000 });
    expect(write({ requestTimeoutSec: 300, maxTokens: 8192, inactivityTimeoutSec: 60 })).toMatchObject({ requestTimeoutSec: 300, maxTokens: 8192 });
  });
});
