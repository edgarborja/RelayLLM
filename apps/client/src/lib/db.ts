import { openDB, deleteDB, type IDBPDatabase } from "idb";
import type { SavedPrompt } from "./prompts.ts";

/**
 * Local, encrypted persistence (IndexedDB).
 *
 * Every record is stored as { id, updatedAt, iv, ct } where ct is AES-256-GCM
 * ciphertext of the JSON value under the identity's data key. Only ids and
 * timestamps are visible to someone with access to the browser profile.
 */

export interface WorkerProfile {
  id: string; // worker pubkey (hex)
  name: string;
  relays: string[];
  addedAt: number;
  lastModel?: string;
}

export type MessageStatus = "streaming" | "done" | "error" | "cancelled";

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  model?: string;
  createdAt: number;
  status?: MessageStatus;
  error?: string;
  /** The response may be missing parts (lost relay events). */
  incomplete?: boolean;
  /** Generation stopped at the token/length limit. */
  truncated?: boolean;
  /** Earlier messages left out of the context for this reply. */
  omitted?: number;
}

export interface Conversation {
  id: string;
  title: string;
  workerId: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessageRecord[];
  /**
   * System prompt sent first with every request in this conversation.
   * Absent in conversations created before system prompts existed, which
   * means no system prompt. Editing it affects only later requests.
   */
  systemPrompt?: string;
}

/** Encrypted, per-identity settings (unlike prefs in localStorage). */
export interface PrivateSettings {
  /** Pre-filled system prompt for new conversations. */
  defaultPrompt?: string;
}

interface EncRecord {
  id: string;
  updatedAt: number;
  iv: Uint8Array;
  ct: ArrayBuffer;
}

type Store = "workers" | "conversations" | "prompts" | "settings";

export class LocalDB {
  private constructor(
    private readonly db: IDBPDatabase,
    private readonly key: CryptoKey,
    readonly name: string,
  ) {}

  static dbName(pubkey: string): string {
    return `relayllm-${pubkey.slice(0, 16)}`;
  }

  static async open(pubkey: string, dataKey: Uint8Array): Promise<LocalDB> {
    const name = LocalDB.dbName(pubkey);
    const db = await openDB(name, 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore("workers", { keyPath: "id" });
          d.createObjectStore("conversations", { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
        }
        if (oldVersion < 2) {
          d.createObjectStore("prompts", { keyPath: "id" });
          d.createObjectStore("settings", { keyPath: "id" });
        }
      },
    });
    const key = await crypto.subtle.importKey("raw", dataKey as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
    return new LocalDB(db, key, name);
  }

  async #put(store: Store, id: string, updatedAt: number, value: unknown): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ad = new TextEncoder().encode(`${store}:${id}`); // bind ciphertext to its slot
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: ad },
      this.key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    await this.db.put(store, { id, updatedAt, iv, ct } satisfies EncRecord);
  }

  async #decrypt<T>(store: Store, r: EncRecord): Promise<T | null> {
    try {
      const ad = new TextEncoder().encode(`${store}:${r.id}`);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: r.iv as BufferSource, additionalData: ad }, this.key, r.ct);
      return JSON.parse(new TextDecoder().decode(pt)) as T;
    } catch {
      return null; // undecryptable (wrong key/corrupt): skip
    }
  }

  async #all<T>(store: Store): Promise<T[]> {
    const rows = (await this.db.getAll(store)) as EncRecord[];
    const out: T[] = [];
    for (const r of rows) {
      const v = await this.#decrypt<T>(store, r);
      if (v) out.push(v);
    }
    return out;
  }

  // workers
  listWorkers(): Promise<WorkerProfile[]> {
    return this.#all<WorkerProfile>("workers").then((w) => w.sort((a, b) => a.addedAt - b.addedAt));
  }
  saveWorker(w: WorkerProfile): Promise<void> {
    return this.#put("workers", w.id, w.addedAt, w);
  }
  async deleteWorker(id: string): Promise<void> {
    await this.db.delete("workers", id);
  }

  // conversations
  async listConversations(): Promise<Conversation[]> {
    return (await this.#all<Conversation>("conversations")).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  saveConversation(c: Conversation): Promise<void> {
    return this.#put("conversations", c.id, c.updatedAt, c);
  }
  async deleteConversation(id: string): Promise<void> {
    await this.db.delete("conversations", id);
  }
  async deleteAllConversations(): Promise<void> {
    await this.db.clear("conversations");
  }

  // system prompt library
  listPrompts(): Promise<SavedPrompt[]> {
    return this.#all<SavedPrompt>("prompts");
  }
  savePrompt(p: SavedPrompt): Promise<void> {
    return this.#put("prompts", p.id, p.updatedAt, p);
  }
  async deletePrompt(id: string): Promise<void> {
    await this.db.delete("prompts", id);
  }

  // settings
  async getSettings(): Promise<PrivateSettings> {
    const r = (await this.db.get("settings", "settings")) as EncRecord | undefined;
    return (r && (await this.#decrypt<PrivateSettings>("settings", r))) || {};
  }
  saveSettings(s: PrivateSettings): Promise<void> {
    return this.#put("settings", "settings", Date.now(), s);
  }

  close(): void {
    this.db.close();
  }

  /** Remove every local record for this identity. */
  async destroy(): Promise<void> {
    this.db.close();
    await deleteDB(this.name);
  }
}
