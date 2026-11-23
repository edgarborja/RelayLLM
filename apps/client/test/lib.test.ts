// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import * as nip19 from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { buildContext } from "../src/lib/context.ts";
import { LocalDB, type Conversation } from "../src/lib/db.ts";
import { createLocalIdentity, loadStoredIdentity, revealNsec, unlockLocal, WrongPasswordError } from "../src/lib/identity.ts";

beforeEach(() => localStorage.clear());

describe("identity vault", () => {
  it("never stores the nsec in plaintext and unlocks only with the right password", async () => {
    const sk = generateSecretKey();
    const nsec = nip19.nsecEncode(sk);
    const created = await createLocalIdentity("hunter2hunter2", sk);
    const raw = JSON.stringify(localStorage);
    expect(raw).not.toContain(nsec);
    expect(raw).not.toContain(Buffer.from(sk).toString("hex"));
    expect(raw).toContain("ncryptsec1");

    const stored = loadStoredIdentity();
    expect(stored?.pubkey).toBe(getPublicKey(sk));
    if (stored?.type !== "local") throw new Error("expected local");
    await expect(unlockLocal(stored, "wrong password")).rejects.toBeInstanceOf(WrongPasswordError);
    const u = await unlockLocal(stored, "hunter2hunter2");
    expect(u.signer.pubkey).toBe(created.signer.pubkey);
    expect(Buffer.from(u.dataKey)).toEqual(Buffer.from(created.dataKey));
    expect(await revealNsec(stored, "hunter2hunter2")).toBe(nsec);
  }, 30_000);

  it("rejects short passwords and malformed stored identities", async () => {
    await expect(createLocalIdentity("short")).rejects.toThrow();
    localStorage.setItem("relayllm.identity.v1", JSON.stringify({ type: "local", pubkey: "nope" }));
    expect(loadStoredIdentity()).toBeNull();
  });
});

describe("encrypted conversation storage", () => {
  const conv = (id: string, text: string): Conversation => ({
    id,
    title: "Secret plans",
    workerId: "a".repeat(64),
    model: "m",
    createdAt: 1,
    updatedAt: Date.now(),
    messages: [{ id: "m1", role: "user", content: text, createdAt: 1 }],
  });

  it("persists conversations and stores only ciphertext", async () => {
    const key = generateSecretKey();
    const pk = "b".repeat(64);
    const db = await LocalDB.open(pk, key);
    await db.saveConversation(conv("c1", "the launch code is 1234"));
    await db.saveWorker({ id: "a".repeat(64), name: "Home", relays: ["wss://r"], addedAt: 1 });
    db.close();

    // Reopen (simulates reload) and read back.
    const db2 = await LocalDB.open(pk, key);
    const list = await db2.listConversations();
    expect(list[0]?.messages[0]?.content).toBe("the launch code is 1234");
    expect((await db2.listWorkers())[0]?.name).toBe("Home");

    // Raw IndexedDB contents contain no plaintext.
    const rawDb = await new Promise<IDBDatabase>((r) => {
      const req = indexedDB.open(LocalDB.dbName(pk));
      req.onsuccess = () => r(req.result);
    });
    const rows = await new Promise<unknown[]>((r) => {
      const req = rawDb.transaction("conversations").objectStore("conversations").getAll();
      req.onsuccess = () => r(req.result);
    });
    rawDb.close();
    const dump = JSON.stringify(rows, (_k, v) => (v instanceof ArrayBuffer ? Buffer.from(v).toString("latin1") : v));
    expect(dump).not.toContain("launch code");
    expect(dump).not.toContain("Secret plans");

    // A different key cannot read it.
    db2.close();
    const db3 = await LocalDB.open(pk, generateSecretKey());
    expect(await db3.listConversations()).toEqual([]);
    await db3.destroy();
  });
});

describe("context building", () => {
  const msg = (role: "user" | "assistant", content: string, i: number) => ({ id: String(i), role, content, createdAt: i });

  it("sends everything when within limits", () => {
    const h = [msg("user", "hi", 1), msg("assistant", "hello", 2), msg("user", "how?", 3)];
    const r = buildContext(h, undefined, "be nice");
    expect(r.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(r.omitted).toBe(0);
  });

  it("drops oldest messages to fit and reports how many", () => {
    const h = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? "assistant" : "user", "x".repeat(1000), i));
    const r = buildContext(h, { maxRequestBytes: 6000, maxMessages: 200, maxResponseChars: 1, requestTimeoutSec: 1 });
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages.length + r.omitted).toBe(20);
    expect(r.tooLarge).toBe(false);
  });

  it("flags a single message that can never fit", () => {
    const r = buildContext([msg("user", "y".repeat(10_000), 1)], { maxRequestBytes: 2000, maxMessages: 10, maxResponseChars: 1, requestTimeoutSec: 1 });
    expect(r.tooLarge).toBe(true);
  });
});
