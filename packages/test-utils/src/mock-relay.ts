import { WebSocketServer, type WebSocket } from "ws";
import { verifyEvent, type Event } from "nostr-tools/pure";
import type { AddressInfo } from "node:net";

/**
 * Minimal NIP-01 relay for tests and local development.
 * Supports EVENT/REQ/CLOSE, OK/EOSE, ephemeral kinds (20000–29999, not
 * stored), NIP-40 expiration, an event size limit, optional NIP-42 AUTH
 * requirement, and fault injection hooks.
 */

interface Filter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [k: string]: unknown;
}

export interface MockRelayOptions {
  port?: number;
  maxMessageBytes?: number;
  requireAuth?: boolean;
  /** Called for each event before delivery; return list of deliveries (for dup/reorder/drop tests). */
  transform?: (event: Event) => Event[] | "drop" | undefined;
  /** Delay before delivering events to subscribers. */
  deliveryDelayMs?: number | (() => number);
}

function matches(f: Filter, e: Event): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith("#") && Array.isArray(v)) {
      const tag = k.slice(1);
      if (!e.tags.some((t) => t[0] === tag && v.includes(t[1]))) return false;
    }
  }
  return true;
}

interface Client {
  ws: WebSocket;
  subs: Map<string, Filter[]>;
  challenge: string;
  authedAs?: string;
}

export class MockRelay {
  readonly #wss: WebSocketServer;
  readonly #clients = new Set<Client>();
  readonly #stored: Event[] = [];
  readonly opts: MockRelayOptions;
  /** Count of events received (for assertions). */
  received: Event[] = [];
  url = "";

  private constructor(wss: WebSocketServer, opts: MockRelayOptions) {
    this.#wss = wss;
    this.opts = opts;
    wss.on("connection", (ws) => this.#onConnection(ws));
  }

  static async start(opts: MockRelayOptions = {}): Promise<MockRelay> {
    const wss = new WebSocketServer({ port: opts.port ?? 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const relay = new MockRelay(wss, opts);
    relay.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    return relay;
  }

  get connectionCount(): number {
    return this.#clients.size;
  }

  #onConnection(ws: WebSocket): void {
    const client: Client = { ws, subs: new Map(), challenge: Math.random().toString(36).slice(2) };
    this.#clients.add(client);
    if (this.opts.requireAuth) ws.send(JSON.stringify(["AUTH", client.challenge]));
    ws.on("close", () => this.#clients.delete(client));
    ws.on("message", (data) => {
      const raw = data.toString();
      if (this.opts.maxMessageBytes && raw.length > this.opts.maxMessageBytes) {
        ws.send(JSON.stringify(["NOTICE", "message too large"]));
        try {
          const m = JSON.parse(raw);
          if (m[0] === "EVENT") ws.send(JSON.stringify(["OK", m[1]?.id, false, "invalid: event too large"]));
        } catch {
          /* ignore */
        }
        return;
      }
      let msg: unknown[];
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      this.#handle(client, msg);
    });
  }

  #handle(c: Client, msg: unknown[]): void {
    const send = (m: unknown[]) => c.ws.readyState === 1 && c.ws.send(JSON.stringify(m));
    switch (msg[0]) {
      case "AUTH": {
        const ev = msg[1] as Event;
        const ok =
          verifyEvent(ev) &&
          ev.kind === 22242 &&
          ev.tags.some((t) => t[0] === "challenge" && t[1] === c.challenge);
        if (ok) c.authedAs = ev.pubkey;
        send(["OK", ev?.id, ok, ok ? "" : "auth-failed"]);
        break;
      }
      case "EVENT": {
        const ev = msg[1] as Event;
        if (!ev || !verifyEvent(ev)) {
          send(["OK", ev?.id, false, "invalid: bad signature"]);
          return;
        }
        if (this.opts.requireAuth && !c.authedAs) {
          send(["OK", ev.id, false, "auth-required: please authenticate"]);
          return;
        }
        this.received.push(ev);
        send(["OK", ev.id, true, ""]);
        const exp = ev.tags.find((t) => t[0] === "expiration")?.[1];
        const ephemeral = ev.kind >= 20000 && ev.kind < 30000;
        if (!ephemeral && !(exp && Number(exp) < Date.now() / 1000)) this.#stored.push(ev);
        const t = this.opts.transform?.(ev);
        if (t === "drop") return;
        for (const e of t ?? [ev]) this.#broadcast(e);
        break;
      }
      case "REQ": {
        const [, id, ...filters] = msg as [string, string, ...Filter[]];
        if (this.opts.requireAuth && !c.authedAs) {
          send(["CLOSED", id, "auth-required: please authenticate"]);
          return;
        }
        c.subs.set(id, filters);
        const now = Date.now() / 1000;
        for (const e of this.#stored) {
          const exp = e.tags.find((t) => t[0] === "expiration")?.[1];
          if (exp && Number(exp) < now) continue;
          if (filters.some((f) => matches(f, e))) send(["EVENT", id, e]);
        }
        send(["EOSE", id]);
        break;
      }
      case "CLOSE":
        c.subs.delete(msg[1] as string);
        break;
    }
  }

  #broadcast(ev: Event): void {
    const deliver = () => {
      for (const c of this.#clients) {
        for (const [id, filters] of c.subs) {
          if (filters.some((f) => matches(f, ev)) && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify(["EVENT", id, ev]));
          }
        }
      }
    };
    const d = typeof this.opts.deliveryDelayMs === "function" ? this.opts.deliveryDelayMs() : this.opts.deliveryDelayMs;
    if (d) setTimeout(deliver, d);
    else deliver();
  }

  /** Forcefully drop every client connection. */
  dropAll(): void {
    for (const c of this.#clients) c.ws.terminate();
    this.#clients.clear();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((r) => this.#wss.close(() => r()));
  }
}
