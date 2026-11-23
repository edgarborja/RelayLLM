import type { Event, EventTemplate } from "nostr-tools/pure";

/**
 * A small multi-relay client with automatic reconnection, resubscription,
 * NIP-42 AUTH, publish acknowledgement tracking, bounded offline queueing
 * and liveness probing. Works with the browser / Node 22 global WebSocket.
 */

export interface Filter {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export type RelayState = "connecting" | "open" | "closed";

export interface RelayStatus {
  url: string;
  state: RelayState;
  lastError?: string;
  connectedSince?: number;
  reconnects: number;
}

export interface PublishResult {
  ok: string[];
  failed: { url: string; reason: string }[];
}

type WebSocketCtor = new (url: string) => WebSocket;

export interface RelayPoolOptions {
  /** Signs NIP-42 AUTH events when a relay requests authentication. */
  authSigner?: (template: EventTemplate) => Promise<Event>;
  WebSocketImpl?: WebSocketCtor;
  /** How long to wait for an OK after publishing. */
  publishTimeoutMs?: number;
  /** Max events queued while no relay is connected. */
  maxQueue?: number;
  /** Interval for liveness probes on idle connections (0 disables). */
  pingIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onStatus?: (status: RelayStatus[]) => void;
}

interface Subscription {
  id: string;
  filter: Filter;
  onEvent: (event: Event, relay: string) => void;
}

interface PendingPublish {
  event: Event;
  resolve: (r: { ok: boolean; reason: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  authRetried: boolean;
}

let subCounter = 0;

class RelayConnection {
  ws: WebSocket | null = null;
  state: RelayState = "closed";
  lastError?: string;
  connectedSince?: number;
  reconnects = 0;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #lastMessageAt = 0;
  #pingOutstanding: { id: string; sentAt: number } | null = null;
  #pending = new Map<string, PendingPublish>();
  #closedByUser = false;
  #authed = false;

  constructor(
    readonly url: string,
    private readonly pool: RelayPool,
  ) {}

  connect(): void {
    if (this.#closedByUser || this.ws) return;
    this.state = "connecting";
    this.pool.emitStatus();
    let ws: WebSocket;
    try {
      ws = new this.pool.WebSocketImpl(this.url);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.state = "open";
      this.#attempt = 0;
      this.#authed = false;
      this.connectedSince = Date.now();
      this.#lastMessageAt = Date.now();
      this.lastError = undefined;
      for (const sub of this.pool.subscriptions.values()) this.sendReq(sub);
      this.#startPing();
      this.pool.emitStatus();
      this.pool.flushQueue();
    };
    ws.onmessage = (m) => {
      this.#lastMessageAt = Date.now();
      this.#onMessage(typeof m.data === "string" ? m.data : String(m.data));
    };
    ws.onerror = () => {
      this.lastError = "connection error";
    };
    ws.onclose = () => {
      this.#teardown();
      if (!this.#closedByUser) this.#scheduleReconnect();
    };
  }

  #teardown(): void {
    this.ws = null;
    this.state = "closed";
    this.connectedSince = undefined;
    this.#pingOutstanding = null;
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, reason: "disconnected" });
      this.#pending.delete(id);
    }
    this.pool.emitStatus();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer || this.#closedByUser) return;
    const base = this.pool.opts.reconnectBaseMs;
    const max = this.pool.opts.reconnectMaxMs;
    const delay = Math.min(max, base * 2 ** this.#attempt) * (0.75 + Math.random() * 0.5);
    this.#attempt = Math.min(this.#attempt + 1, 16);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.reconnects++;
      this.connect();
    }, delay);
  }

  /** Force a reconnect now (e.g. browser came back online). */
  kick(): void {
    if (this.#closedByUser) return;
    if (this.state === "closed") {
      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      this.#attempt = 0;
      this.connect();
    } else if (this.state === "open") {
      this.#probe();
    }
  }

  #startPing(): void {
    const every = this.pool.opts.pingIntervalMs;
    if (!every) return;
    this.#pingTimer = setInterval(() => {
      const now = Date.now();
      if (this.#pingOutstanding && now - this.#pingOutstanding.sentAt > every) {
        this.lastError = "liveness probe timed out";
        this.dropConnection();
        return;
      }
      if (!this.#pingOutstanding && now - this.#lastMessageAt > every) this.#probe();
    }, Math.max(1000, Math.floor(every / 2)));
  }

  #probe(): void {
    if (this.#pingOutstanding) return;
    const id = `ping-${++subCounter}`;
    this.#pingOutstanding = { id, sentAt: Date.now() };
    // Cheap query that matches nothing; relay answers with EOSE.
    this.send(["REQ", id, { ids: ["0".repeat(64)], limit: 1 }]);
  }

  /** Close the socket and let the reconnect logic take over. */
  dropConnection(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    this.#teardown();
    this.#scheduleReconnect();
  }

  close(): void {
    this.#closedByUser = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const ws = this.ws;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.#teardown();
  }

  send(msg: unknown[]): boolean {
    if (this.state !== "open" || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  sendReq(sub: Subscription): void {
    this.send(["REQ", sub.id, sub.filter]);
  }

  publish(event: Event): Promise<{ ok: boolean; reason: string }> {
    return new Promise((resolve) => {
      if (this.#pending.has(event.id)) {
        resolve({ ok: false, reason: "duplicate publish in flight" });
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(event.id);
        resolve({ ok: false, reason: "timeout" });
      }, this.pool.opts.publishTimeoutMs);
      this.#pending.set(event.id, { event, resolve, timer, authRetried: false });
      if (!this.send(["EVENT", event])) {
        clearTimeout(timer);
        this.#pending.delete(event.id);
        resolve({ ok: false, reason: "not connected" });
      }
    });
  }

  #onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
    switch (msg[0]) {
      case "EVENT": {
        const sub = this.pool.subscriptions.get(msg[1] as string);
        const ev = msg[2] as Event;
        if (sub && ev && typeof ev === "object") sub.onEvent(ev, this.url);
        break;
      }
      case "EOSE": {
        if (this.#pingOutstanding && msg[1] === this.#pingOutstanding.id) {
          this.send(["CLOSE", this.#pingOutstanding.id]);
          this.#pingOutstanding = null;
        }
        break;
      }
      case "OK": {
        const [, id, ok, reason] = msg as [string, string, boolean, string];
        const p = this.#pending.get(id);
        if (!p) break;
        const why = typeof reason === "string" ? reason : "";
        if (!ok && why.startsWith("auth-required") && !p.authRetried && this.pool.opts.authSigner) {
          // Will be re-sent after AUTH completes.
          p.authRetried = true;
          break;
        }
        clearTimeout(p.timer);
        this.#pending.delete(id);
        p.resolve({ ok: !!ok, reason: why });
        break;
      }
      case "CLOSED": {
        const [, subId, reason] = msg as [string, string, string];
        if (this.#pingOutstanding && subId === this.#pingOutstanding.id) {
          this.#pingOutstanding = null;
          break;
        }
        if (typeof reason === "string" && reason.startsWith("auth-required")) {
          // Resubscribe once authenticated.
          break;
        }
        this.lastError = `subscription closed: ${String(reason).slice(0, 100)}`;
        this.pool.emitStatus();
        break;
      }
      case "AUTH": {
        const challenge = msg[1];
        if (typeof challenge === "string") void this.#authenticate(challenge);
        break;
      }
      case "NOTICE":
      default:
        break;
    }
  }

  async #authenticate(challenge: string): Promise<void> {
    const signer = this.pool.opts.authSigner;
    if (!signer || challenge.length > 256) return;
    try {
      const ev = await signer({
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", this.url],
          ["challenge", challenge],
        ],
        content: "",
      });
      this.send(["AUTH", ev]);
      this.#authed = true;
      // Give the relay a moment to process AUTH, then retry anything rejected.
      setTimeout(() => {
        for (const sub of this.pool.subscriptions.values()) this.sendReq(sub);
        for (const p of this.#pending.values()) if (p.authRetried) this.send(["EVENT", p.event]);
      }, 200);
    } catch (e) {
      this.lastError = `auth failed: ${(e as Error).message}`;
    }
  }

  get authed(): boolean {
    return this.#authed;
  }
}

export class RelayPool {
  readonly relays = new Map<string, RelayConnection>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly opts: Required<Omit<RelayPoolOptions, "authSigner" | "onStatus" | "WebSocketImpl">> &
    Pick<RelayPoolOptions, "authSigner" | "onStatus">;
  readonly WebSocketImpl: WebSocketCtor;
  #queue: { event: Event; resolve: (r: PublishResult) => void; deadline: number }[] = [];
  #closed = false;

  constructor(urls: string[], opts: RelayPoolOptions = {}) {
    this.WebSocketImpl = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    if (!this.WebSocketImpl) throw new Error("No WebSocket implementation available");
    this.opts = {
      publishTimeoutMs: opts.publishTimeoutMs ?? 8000,
      maxQueue: opts.maxQueue ?? 200,
      pingIntervalMs: opts.pingIntervalMs ?? 30_000,
      reconnectBaseMs: opts.reconnectBaseMs ?? 1000,
      reconnectMaxMs: opts.reconnectMaxMs ?? 30_000,
      authSigner: opts.authSigner,
      onStatus: opts.onStatus,
    };
    for (const url of new Set(urls)) this.relays.set(url, new RelayConnection(url, this));
  }

  connect(): void {
    for (const r of this.relays.values()) r.connect();
  }

  subscribe(filter: Filter, onEvent: (event: Event, relay: string) => void): { close: () => void } {
    const sub: Subscription = { id: `sub-${++subCounter}`, filter, onEvent };
    this.subscriptions.set(sub.id, sub);
    for (const r of this.relays.values()) r.sendReq(sub);
    return {
      close: () => {
        this.subscriptions.delete(sub.id);
        for (const r of this.relays.values()) r.send(["CLOSE", sub.id]);
      },
    };
  }

  /**
   * Publish to every connected relay. Resolves when at least one relay accepts
   * it or all have failed. If no relay is connected, the event is queued
   * (bounded) until one connects or its expiration passes.
   */
  publish(event: Event, opts: { expiresAt?: number } = {}): Promise<PublishResult> {
    const open = [...this.relays.values()].filter((r) => r.state === "open");
    if (open.length === 0) {
      return new Promise((resolve) => {
        if (this.#closed) return resolve({ ok: [], failed: [{ url: "*", reason: "closed" }] });
        if (this.#queue.length >= this.opts.maxQueue) {
          return resolve({ ok: [], failed: [{ url: "*", reason: "offline queue full" }] });
        }
        const deadline = (opts.expiresAt ?? Math.floor(Date.now() / 1000) + 60) * 1000;
        const item = { event, resolve, deadline };
        this.#queue.push(item);
        setTimeout(() => {
          const i = this.#queue.indexOf(item);
          if (i >= 0) {
            this.#queue.splice(i, 1);
            resolve({ ok: [], failed: [{ url: "*", reason: "expired while offline" }] });
          }
        }, Math.max(0, deadline - Date.now()));
      });
    }
    return this.#publishTo(event, open);
  }

  #publishTo(event: Event, relays: RelayConnection[]): Promise<PublishResult> {
    return new Promise((resolve) => {
      const result: PublishResult = { ok: [], failed: [] };
      let remaining = relays.length;
      let resolved = false;
      for (const r of relays) {
        void r.publish(event).then(({ ok, reason }) => {
          if (ok) result.ok.push(r.url);
          else result.failed.push({ url: r.url, reason });
          remaining--;
          if (!resolved && (ok || remaining === 0)) {
            resolved = true;
            resolve(result);
          }
        });
      }
    });
  }

  flushQueue(): void {
    const now = Date.now();
    const q = this.#queue;
    this.#queue = [];
    for (const item of q) {
      if (item.deadline < now) {
        item.resolve({ ok: [], failed: [{ url: "*", reason: "expired while offline" }] });
        continue;
      }
      const open = [...this.relays.values()].filter((r) => r.state === "open");
      if (open.length === 0) this.#queue.push(item);
      else void this.#publishTo(item.event, open).then(item.resolve);
    }
  }

  /** Reconnect closed relays immediately and probe open ones. */
  kick(): void {
    for (const r of this.relays.values()) r.kick();
  }

  status(): RelayStatus[] {
    return [...this.relays.values()].map((r) => ({
      url: r.url,
      state: r.state,
      lastError: r.lastError,
      connectedSince: r.connectedSince,
      reconnects: r.reconnects,
    }));
  }

  get connectedCount(): number {
    let n = 0;
    for (const r of this.relays.values()) if (r.state === "open") n++;
    return n;
  }

  emitStatus(): void {
    this.opts.onStatus?.(this.status());
  }

  /** Test hook: drop all sockets as if the network failed. */
  simulateDisconnect(): void {
    for (const r of this.relays.values()) r.dropConnection();
  }

  close(): void {
    this.#closed = true;
    for (const r of this.relays.values()) r.close();
    for (const item of this.#queue) item.resolve({ ok: [], failed: [{ url: "*", reason: "closed" }] });
    this.#queue = [];
  }
}
