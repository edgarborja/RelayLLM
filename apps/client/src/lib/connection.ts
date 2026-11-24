import { generateSecretKey } from "nostr-tools/pure";
import {
  LocalSigner,
  RelayPool,
  RemoteError,
  WorkerClient,
  type CancelOutcome,
  type ChatHandle,
  type ChatCallbacks,
  type RelayStatus,
  type Signer,
} from "@relayllm/nostr-transport";
import type { ChatMessage, ChatParams, Limits, MetricsResult, ModelInfo } from "@relayllm/protocol";
import type { WorkerProfile } from "./db.ts";

export type AccessState = "unknown" | "checking" | "approved" | "unauthorized" | "pending" | "unreachable";

export interface ConnectionState {
  relays: RelayStatus[];
  online: boolean;
  access: AccessState;
  models: ModelInfo[];
  limits?: Limits;
  batchMs?: number;
  serverName?: string;
  error?: string;
}

type Listener = (s: ConnectionState) => void;

/**
 * One live connection to a worker: its relay pool, a per-session reply key,
 * and the protocol client. UI subscribes to state changes.
 */
export class WorkerConnection {
  readonly client: WorkerClient;
  readonly #pool: RelayPool;
  readonly #listeners = new Set<Listener>();
  #state: ConnectionState;
  #refreshing: Promise<void> | null = null;

  constructor(
    readonly profile: WorkerProfile,
    identity: Signer,
  ) {
    // Fresh per-session key: receives replies and answers relay AUTH, so the
    // long-term identity is never exposed to relays and NIP-07 users are not
    // prompted for every streamed chunk.
    const session = new LocalSigner(generateSecretKey());
    this.#pool = new RelayPool(profile.relays, {
      authSigner: (t) => session.signEvent(t),
      onStatus: (relays) => this.#onRelayStatus(relays),
    });
    this.client = new WorkerClient({
      pool: this.#pool,
      identity,
      workerPubkey: profile.id,
      session,
      requestTimeoutMs: 15_000,
    });
    this.#state = { relays: this.#pool.status(), online: false, access: "unknown", models: [] };
    this.client.start();
  }

  get state(): ConnectionState {
    return this.#state;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    fn(this.#state);
    return () => this.#listeners.delete(fn);
  }

  #set(patch: Partial<ConnectionState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l(this.#state);
  }

  #onRelayStatus(relays: RelayStatus[]): void {
    const online = relays.some((r) => r.state === "open");
    const wasOnline = this.#state.online;
    this.#set({ relays, online });
    this.client.onConnectivity(online);
    if (online && !wasOnline && (this.#state.access === "unknown" || this.#state.access === "unreachable")) {
      // Give subscriptions a moment to be registered on the relay.
      setTimeout(() => void this.refresh(), 300);
    }
  }

  /** Reconnect now (e.g. network came back or tab became visible). */
  kick(): void {
    this.#pool.kick();
  }

  /** Query server info and models; derives access state from errors. */
  refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      this.#set({ access: this.#state.access === "approved" ? "approved" : "checking", error: undefined });
      try {
        const info = await this.client.serverInfo();
        const models = await this.client.listModels();
        this.#set({
          access: "approved",
          models,
          limits: info.limits,
          batchMs: info.streaming.batchMs,
          serverName: info.name,
        });
      } catch (e) {
        this.#set(errorToState(e));
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async requestAccess(token?: string, label?: string): Promise<void> {
    try {
      const status = await this.client.pair(token, label);
      if (status === "approved") await this.refresh();
      else this.#set({ access: status === "pending" ? "pending" : "unauthorized" });
    } catch (e) {
      this.#set(errorToState(e));
    }
  }

  /** Read-only metrics (model metadata; machine stats if `host` and enabled by the owner). */
  metrics(opts: { model?: string; host?: boolean }): Promise<MetricsResult> {
    return this.client.metrics(opts);
  }

  chat(req: { model: string; messages: ChatMessage[]; params?: ChatParams }, cb: ChatCallbacks): ChatHandle {
    // The worker enforces the limit; wait a little longer than it does.
    const limit = this.#state.limits?.requestTimeoutSec;
    return this.client.chat(req, cb, { timeoutMs: limit ? (limit + 60) * 1000 : undefined });
  }

  cancelRequest(id: string): Promise<CancelOutcome> {
    return this.client.cancelRequest(id);
  }

  close(): void {
    this.client.stop();
    this.#pool.close();
    this.#listeners.clear();
  }
}

function errorToState(e: unknown): Partial<ConnectionState> {
  if (e instanceof RemoteError) {
    if (e.code === "unauthorized") return { access: "unauthorized", models: [] };
    if (e.code === "pending_approval") return { access: "pending", models: [] };
    if (e.code === "no_response" || e.code === "publish_failed") return { access: "unreachable", error: e.message };
    return { error: e.message };
  }
  return { error: (e as Error).message };
}

/** Keeps one connection per worker for the lifetime of the unlocked session. */
export class ConnectionManager {
  readonly #conns = new Map<string, WorkerConnection>();
  constructor(private readonly identity: Signer) {
    const kickAll = () => {
      for (const c of this.#conns.values()) c.kick();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", kickAll);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") kickAll();
      });
    }
  }

  get(profile: WorkerProfile): WorkerConnection {
    let c = this.#conns.get(profile.id);
    if (c && c.profile.relays.join() !== profile.relays.join()) {
      c.close();
      c = undefined;
    }
    if (!c) {
      c = new WorkerConnection(profile, this.identity);
      this.#conns.set(profile.id, c);
    }
    return c;
  }

  remove(id: string): void {
    this.#conns.get(id)?.close();
    this.#conns.delete(id);
  }

  closeAll(): void {
    for (const c of this.#conns.values()) c.close();
    this.#conns.clear();
  }
}
