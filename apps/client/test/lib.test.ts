// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import * as nip19 from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { buildContext } from "../src/lib/context.ts";
import { LocalDB, type Conversation } from "../src/lib/db.ts";
import { describePrompt, rememberPrompt, TEMPLATES } from "../src/lib/prompts.ts";
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

describe("system prompts", () => {
  const msg = (role: "user" | "assistant", content: string, i: number) => ({ id: String(i), role, content, createdAt: i });
  const history = [msg("user", "hi", 1), msg("assistant", "hello", 2), msg("user", "again", 3)];

  it("puts the conversation's prompt first and leaves the history untouched", () => {
    const a = buildContext(history, undefined, "You are a pirate.");
    const b = buildContext(history, undefined, "You are a translator.");
    expect(a.messages[0]).toEqual({ role: "system", content: "You are a pirate." });
    expect(b.messages[0]).toEqual({ role: "system", content: "You are a translator." });
    expect(a.messages.slice(1)).toEqual(b.messages.slice(1));
    expect(a.messages.slice(1).map((m) => m.content)).toEqual(["hi", "hello", "again"]);
    // Conversations saved before system prompts existed: no system message.
    expect(buildContext(history, undefined, undefined).messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(buildContext(history, undefined, "   ").messages[0]!.role).toBe("user");
  });

  it("keeps the prompt when old messages are dropped to fit the limits", () => {
    const long = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? "assistant" : "user", "x".repeat(1000), i));
    const r = buildContext(long, { maxRequestBytes: 6000, maxMessages: 200, maxResponseChars: 1, requestTimeoutSec: 1 }, "Be brief.");
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.messages[0]).toEqual({ role: "system", content: "Be brief." });
    expect(r.messages[1]!.role).toBe("user");
  });

  it("ships the starter templates and remembers custom prompts once", () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      "Spanish ⇄ English translator",
      "Civil War era fiction writer",
      "Sponsor–child correspondence reviewer",
    ]);
    expect(rememberPrompt([], TEMPLATES[0]!.content)).toBeNull(); // templates aren't copied
    expect(rememberPrompt([], "  ")).toBeNull();
    const first = rememberPrompt([], "Answer like a 1920s radio host.\nKeep it short.", 1000)!;
    expect(first.name).toBe("Answer like a 1920s radio host.");
    const again = rememberPrompt([first], "Answer like a 1920s radio host.\nKeep it short.", 2000)!;
    expect(again.id).toBe(first.id);
    expect(again.lastUsedAt).toBe(2000);
    expect(describePrompt(TEMPLATES[2]!.content, [])).toBe("Sponsor–child correspondence reviewer");
    expect(describePrompt("", [first])).toBe("None");
  });

  it("stores prompts and settings encrypted, and upgrades old databases without losing conversations", async () => {
    const key = generateSecretKey();
    const pk = "c".repeat(64);
    // A database written by the previous version (v1: workers + conversations only).
    const aes = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
    const old: Conversation = {
      id: "old1",
      title: "Before prompts",
      workerId: "a".repeat(64),
      model: "m",
      createdAt: 1,
      updatedAt: 5,
      messages: [{ id: "m1", role: "user", content: "legacy text", createdAt: 1 }],
    };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("conversations:old1") },
      aes,
      new TextEncoder().encode(JSON.stringify(old)),
    );
    await new Promise<void>((resolve) => {
      const req = indexedDB.open(LocalDB.dbName(pk), 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("workers", { keyPath: "id" });
        req.result.createObjectStore("conversations", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
      };
      req.onsuccess = () => {
        const tx = req.result.transaction("conversations", "readwrite");
        tx.objectStore("conversations").put({ id: "old1", updatedAt: 5, iv, ct });
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
      };
    });

    const db = await LocalDB.open(pk, key);
    const [conv] = await db.listConversations();
    expect(conv?.messages[0]?.content).toBe("legacy text");
    expect(conv?.systemPrompt).toBeUndefined();

    // Two conversations, each with its own prompt, plus a saved prompt and the default.
    await db.saveConversation({ ...old, id: "p1", systemPrompt: "You are a pirate." });
    await db.saveConversation({ ...old, id: "p2", systemPrompt: "You are a translator." });
    const saved = rememberPrompt([], "my confidential reviewer prompt")!;
    await db.savePrompt(saved);
    await db.saveSettings({ defaultPrompt: "my confidential default" });
    db.close();

    const db2 = await LocalDB.open(pk, key);
    const byId = new Map((await db2.listConversations()).map((c) => [c.id, c]));
    expect(byId.get("p1")?.systemPrompt).toBe("You are a pirate.");
    expect(byId.get("p2")?.systemPrompt).toBe("You are a translator.");
    expect(byId.get("old1")?.systemPrompt).toBeUndefined();
    expect((await db2.listPrompts())[0]?.content).toBe("my confidential reviewer prompt");
    expect((await db2.getSettings()).defaultPrompt).toBe("my confidential default");
    db2.close();

    const raw = await new Promise<IDBDatabase>((r) => {
      const req = indexedDB.open(LocalDB.dbName(pk));
      req.onsuccess = () => r(req.result);
    });
    const dump: unknown[] = [];
    for (const store of ["conversations", "prompts", "settings"]) {
      dump.push(
        await new Promise<unknown[]>((r) => {
          const req = raw.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => r(req.result);
        }),
      );
    }
    raw.close();
    const text = JSON.stringify(dump, (_k, v) => (v instanceof ArrayBuffer ? Buffer.from(v).toString("latin1") : v));
    for (const secret of ["pirate", "translator", "confidential"]) expect(text).not.toContain(secret);
  });
});
