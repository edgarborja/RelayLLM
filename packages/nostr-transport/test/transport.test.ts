import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import {
  fragmentText,
  INNER_KIND,
  isFragment,
  LocalSigner,
  parsePairingUrl,
  buildPairingUrl,
  Reassembler,
  ReplayGuard,
  signInner,
  StreamAssembler,
  unwrap,
  UnwrapError,
  WRAP_KIND,
  wrapInner,
  normalizeRelayUrl,
} from "../src/index.ts";

const alice = new LocalSigner(generateSecretKey());
const worker = new LocalSigner(generateSecretKey());
const recipients = new Map([[worker.pubkey, worker]]);

async function expectUnwrapError(p: Promise<unknown>, reason: string) {
  await expect(p).rejects.toBeInstanceOf(UnwrapError);
  await expect(p).rejects.toMatchObject({ reason });
}

describe("wrap / unwrap", () => {
  it("round-trips an authenticated, encrypted message", async () => {
    const inner = await signInner(alice, worker.pubkey, '{"hello":"world"}');
    const outer = wrapInner(inner, worker.pubkey, Math.floor(Date.now() / 1000) + 60);
    expect(outer.kind).toBe(WRAP_KIND);
    expect(outer.pubkey).not.toBe(alice.pubkey); // sender hidden from relays
    expect(outer.content).not.toContain("hello");
    expect(outer.tags).toContainEqual(["p", worker.pubkey]);
    const u = await unwrap(outer, recipients);
    expect(u.sender).toBe(alice.pubkey);
    expect(u.content).toBe('{"hello":"world"}');
  });

  it("rejects events not addressed to us", async () => {
    const other = new LocalSigner(generateSecretKey());
    const inner = await signInner(alice, other.pubkey, "{}");
    const outer = wrapInner(inner, other.pubkey, 0);
    await expectUnwrapError(unwrap(outer, recipients), "not addressed to us");
  });

  it("rejects a tampered outer event", async () => {
    const inner = await signInner(alice, worker.pubkey, "{}");
    const outer = wrapInner(inner, worker.pubkey, 0);
    const tampered = JSON.parse(JSON.stringify(outer)); // as received from a relay
    tampered.content = outer.content.slice(0, -8) + "AAAAAAAA";
    await expectUnwrapError(unwrap(tampered, recipients), "bad outer signature");
  });

  it("rejects a spoofed sender (inner pubkey swapped)", async () => {
    const mallory = generateSecretKey();
    const inner = await signInner(new LocalSigner(mallory), worker.pubkey, '{"x":1}');
    const spoofed = { ...inner, pubkey: alice.pubkey }; // claims to be alice
    const outer = wrapInner(spoofed, worker.pubkey, 0);
    await expectUnwrapError(unwrap(outer, recipients), "bad inner signature");
  });

  it("rejects an inner event with a forged content (signature mismatch)", async () => {
    const inner = await signInner(alice, worker.pubkey, '{"a":1}');
    const outer = wrapInner({ ...inner, content: '{"a":2}' }, worker.pubkey, 0);
    await expectUnwrapError(unwrap(outer, recipients), "bad inner signature");
  });

  it("rejects a message re-wrapped to a different recipient", async () => {
    const other = new LocalSigner(generateSecretKey());
    // Alice sent this to `other`; attacker re-wraps it to the worker.
    const inner = await signInner(alice, other.pubkey, "{}");
    const outer = wrapInner(inner, worker.pubkey, 0);
    await expectUnwrapError(unwrap(outer, recipients), "inner recipient mismatch");
  });

  it("rejects wrong inner kind and garbage plaintext", async () => {
    const sk = generateSecretKey();
    const wrong = finalizeEvent({ kind: 1, created_at: 1, tags: [["p", worker.pubkey]], content: "" }, generateSecretKey());
    const outer1 = finalizeEvent(
      {
        kind: WRAP_KIND,
        created_at: 1,
        tags: [["p", worker.pubkey]],
        content: nip44.encrypt(JSON.stringify(wrong), nip44.getConversationKey(sk, worker.pubkey)),
      },
      sk,
    );
    await expectUnwrapError(unwrap(outer1, recipients), "malformed inner event");
    const outer2 = finalizeEvent(
      { kind: WRAP_KIND, created_at: 1, tags: [["p", worker.pubkey]], content: nip44.encrypt("not json", nip44.getConversationKey(sk, worker.pubkey)) },
      sk,
    );
    await expectUnwrapError(unwrap(outer2, recipients), "inner not JSON");
  });

  it("rejects undecryptable payloads", async () => {
    const sk = generateSecretKey();
    const outer = finalizeEvent({ kind: WRAP_KIND, created_at: 1, tags: [["p", worker.pubkey]], content: "AAAA" }, sk);
    await expectUnwrapError(unwrap(outer, recipients), "decryption failed");
  });

  it("uses the expected inner kind", async () => {
    const inner = await signInner(alice, worker.pubkey, "{}");
    expect(inner.kind).toBe(INNER_KIND);
    expect(getPublicKey(generateSecretKey())).toHaveLength(64);
  });
});

describe("ReplayGuard", () => {
  it("accepts once, rejects replays, stale and future events", () => {
    const g = new ReplayGuard({ maxAgeSec: 120, maxSkewSec: 30 });
    const now = 1_000_000;
    expect(g.check("a", now, now)).toBe("ok");
    expect(g.check("a", now, now + 5)).toBe("replay");
    expect(g.check("b", now - 121, now)).toBe("stale");
    expect(g.check("c", now + 31, now)).toBe("future");
    expect(g.check("d", now - 100, now)).toBe("ok");
  });
});

describe("fragmentation", () => {
  it("does not fragment small messages", () => {
    expect(fragmentText("hello", 1000, "f".repeat(16))).toEqual(["hello"]);
  });

  it("splits and reassembles large, multi-byte text with integrity", () => {
    const text = JSON.stringify({ s: "日本語🙂\"quotes\"\\".repeat(5000) });
    const frags = fragmentText(text, 8000, "fid_0123456789abcd");
    expect(frags.length).toBeGreaterThan(5);
    for (const f of frags) expect(new TextEncoder().encode(f).length).toBeLessThanOrEqual(8000);
    const r = new Reassembler();
    const parsed = frags.map((f) => JSON.parse(f));
    // Out of order + duplicate delivery
    const order = [...parsed].reverse();
    order.splice(2, 0, parsed[0]);
    const results = order.map((p) => {
      expect(isFragment(p)).toBe(true);
      return r.add("sender", p);
    });
    expect(results.filter((x) => x.status === "complete")).toEqual([{ status: "complete", text }]);
  });

  it("rejects tampered fragments", () => {
    const text = "x".repeat(20000);
    const frags = fragmentText(text, 5000, "fid_0123456789abcd").map((f) => JSON.parse(f));
    frags[1].data = frags[1].data.replace("x", "y");
    const r = new Reassembler();
    const results = frags.map((f) => r.add("s", f));
    expect(results.at(-1)).toEqual({ status: "rejected", reason: "integrity check failed" });
  });

  it("bounds fragment count, size and per-sender pending", () => {
    const r = new Reassembler({ maxFragments: 4, maxTotalBytes: 100, maxPendingPerSender: 1 });
    const frag = (fid: string, i: number, n: number, data: string) => ({ type: "frag" as const, fid, i, n, sha256: "0".repeat(64), data });
    expect(r.add("s", frag("a".repeat(16), 0, 5, "x"))).toMatchObject({ status: "rejected", reason: "too many fragments" });
    expect(r.add("s", frag("b".repeat(16), 0, 2, "x"))).toEqual({ status: "partial" });
    expect(r.add("s", frag("c".repeat(16), 0, 2, "x"))).toMatchObject({ status: "rejected", reason: "too many pending" });
    expect(r.add("t", frag("d".repeat(16), 0, 2, "x".repeat(101)))).toMatchObject({ status: "rejected", reason: "message too large" });
  });

  it("expires incomplete messages", () => {
    const r = new Reassembler({ timeoutMs: 1000 });
    const f = { type: "frag" as const, fid: "e".repeat(16), i: 0, n: 2, sha256: "0".repeat(64), data: "x" };
    r.add("s", f, 0);
    expect(r.pendingCount).toBe(1);
    r.add("s", { ...f, fid: "g".repeat(16) }, 5000);
    expect(r.pendingCount).toBe(1); // first expired
  });
});

describe("StreamAssembler", () => {
  it("orders, de-duplicates and reports gaps", () => {
    const a = new StreamAssembler();
    expect(a.add(1, "b")).toBe(false);
    expect(a.hasGap).toBe(true);
    expect(a.missing(2)).toEqual([0]);
    expect(a.add(0, "a", "think")).toBe(true);
    expect(a.add(0, "a")).toBe(false); // duplicate
    expect(a.add(1, "b")).toBe(false); // duplicate
    expect(a.add(3, "d")).toBe(false);
    expect(a.seenUpTo).toBe(4);
    expect(a.missing(4)).toEqual([2]);
    expect(a.add(2, "c")).toBe(true);
    expect(a.content).toBe("abcd");
    expect(a.reasoning).toBe("think");
    expect(a.hasGap).toBe(false);
  });
});

describe("pairing URLs", () => {
  it("round-trips worker, relays, name and puts invite in the fragment", () => {
    const url = buildPairingUrl("https://example.github.io/relayllm/", {
      workerPubkey: worker.pubkey,
      relays: ["wss://relay.example", "wss://relay2.example/path"],
      name: "Home Mac",
      invite: "abcdefghijklmnop1234",
    });
    expect(url).toMatch(/\?worker=npub1/);
    expect(url).toContain("#invite=abcdefghijklmnop1234");
    expect(url).not.toMatch(/nsec/);
    const p = parsePairingUrl(url)!;
    expect(p.workerPubkey).toBe(worker.pubkey);
    expect(p.relays).toEqual(["wss://relay.example", "wss://relay2.example/path"]);
    expect(p.name).toBe("Home Mac");
    expect(p.invite).toBe("abcdefghijklmnop1234");
  });

  it("treats parameters as untrusted", () => {
    expect(parsePairingUrl("https://x/?worker=npub1garbage")).toBeNull();
    const p = parsePairingUrl(
      `https://x/?worker=${worker.pubkey}&relay=javascript:alert(1)&relay=https://evil&relay=wss://user:pw@r.example&relay=wss://ok.example#invite=<script>`,
    )!;
    expect(p.relays).toEqual(["wss://ok.example"]);
    expect(p.invite).toBeUndefined();
    expect(normalizeRelayUrl("relay.example")).toBe("wss://relay.example");
  });
});
