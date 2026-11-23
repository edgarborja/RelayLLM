import type { Event } from "nostr-tools/pure";
import { fragmentText, isFragment, Reassembler, type ReassemblerLimits } from "./fragment.ts";
import { RelayPool, type PublishResult } from "./relay-pool.ts";
import { ReplayGuard, SeenSet } from "./replay.ts";
import type { Signer } from "./signer.ts";
import {
  DEFAULT_MAX_INNER_BYTES,
  signInner,
  unwrap,
  UnwrapError,
  WRAP_KIND,
  wrapInner,
} from "./wrap.ts";

export interface IncomingMessage {
  /** Authenticated sender public key (hex). */
  sender: string;
  /** Which of our keys it was addressed to. */
  recipient: string;
  /** Parsed JSON payload — UNTRUSTED, validate before use. */
  payload: unknown;
  /** Total serialized size in bytes (after reassembly). */
  size: number;
}

export interface DropInfo {
  reason: string;
  sender?: string;
}

export interface EndpointOptions {
  pool: RelayPool;
  /** Identity that signs outgoing inner events. */
  signer: Signer;
  /** Keys we accept incoming messages for (defaults to [signer]). */
  receivers?: Signer[];
  maxInnerBytes?: number;
  replay?: ReplayGuard;
  reassembly?: Partial<ReassemblerLimits>;
  onMessage: (msg: IncomingMessage) => void;
  /** Diagnostics for dropped events. Never includes plaintext. */
  onDrop?: (info: DropInfo) => void;
  /** Lets the owner reject senders before reassembling multi-event messages. */
  acceptFragmentsFrom?: (sender: string) => boolean;
}

/**
 * Encrypted, authenticated message endpoint over a RelayPool.
 * Handles wrapping, de-duplication, replay protection and fragmentation.
 */
export class NostrEndpoint {
  readonly #opts: EndpointOptions;
  readonly #receivers: Map<string, Signer>;
  readonly #seenOuter = new SeenSet(20_000);
  readonly #replay: ReplayGuard;
  readonly #reassembler: Reassembler;
  #sub: { close: () => void } | null = null;
  #since = 0;

  constructor(opts: EndpointOptions) {
    this.#opts = opts;
    const receivers = opts.receivers ?? [opts.signer];
    this.#receivers = new Map(receivers.map((s) => [s.pubkey, s]));
    this.#replay = opts.replay ?? new ReplayGuard();
    this.#reassembler = new Reassembler(opts.reassembly);
  }

  get pubkey(): string {
    return this.#opts.signer.pubkey;
  }

  start(): void {
    if (this.#sub) return;
    this.#since = Math.floor(Date.now() / 1000) - 10;
    this.#sub = this.#opts.pool.subscribe(
      { kinds: [WRAP_KIND], "#p": [...this.#receivers.keys()], since: this.#since },
      (ev) => void this.#handle(ev),
    );
    this.#opts.pool.connect();
  }

  stop(): void {
    this.#sub?.close();
    this.#sub = null;
  }

  async #handle(ev: Event): Promise<void> {
    if (typeof ev.id !== "string" || !this.#seenOuter.add(ev.id)) return;
    let u;
    try {
      u = await unwrap(ev, this.#receivers);
    } catch (e) {
      this.#opts.onDrop?.({ reason: e instanceof UnwrapError ? e.reason : "unwrap error" });
      return;
    }
    const verdict = this.#replay.check(u.innerId, u.createdAt);
    if (verdict !== "ok") {
      this.#opts.onDrop?.({ reason: verdict, sender: u.sender });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(u.content);
    } catch {
      this.#opts.onDrop?.({ reason: "content not JSON", sender: u.sender });
      return;
    }
    if (isFragment(payload)) {
      if (this.#opts.acceptFragmentsFrom && !this.#opts.acceptFragmentsFrom(u.sender)) {
        this.#opts.onDrop?.({ reason: "fragments not accepted from sender", sender: u.sender });
        return;
      }
      const r = this.#reassembler.add(u.sender, payload);
      if (r.status === "rejected") {
        this.#opts.onDrop?.({ reason: `fragment: ${r.reason}`, sender: u.sender });
        return;
      }
      if (r.status === "partial") return;
      try {
        payload = JSON.parse(r.text);
      } catch {
        this.#opts.onDrop?.({ reason: "reassembled content not JSON", sender: u.sender });
        return;
      }
      this.#opts.onMessage({ sender: u.sender, recipient: u.recipient, payload, size: r.text.length });
      return;
    }
    this.#opts.onMessage({ sender: u.sender, recipient: u.recipient, payload, size: u.content.length });
  }

  /**
   * Encrypt and publish a message to `recipient`. Large messages are split
   * into fragments. Resolves once every fragment was accepted by ≥1 relay;
   * rejects if any fragment could not be published.
   */
  async send(recipient: string, message: object, opts: { expiresAt?: number; fid?: string } = {}): Promise<PublishResult> {
    const text = JSON.stringify(message);
    const expiresAt =
      opts.expiresAt ??
      ((message as { exp?: unknown }).exp as number | undefined) ??
      Math.floor(Date.now() / 1000) + 120;
    const fid = opts.fid ?? (message as { id?: string }).id ?? randomFid();
    // Inner event overhead (~420 bytes: id, pubkey, sig, tags) is reserved.
    const pieces = fragmentText(text, (this.#opts.maxInnerBytes ?? DEFAULT_MAX_INNER_BYTES) - 512, fid);
    const results: PublishResult[] = [];
    for (const piece of pieces) {
      const inner = await signInner(this.#opts.signer, recipient, piece);
      const outer = wrapInner(inner, recipient, expiresAt);
      const r = await this.#opts.pool.publish(outer, { expiresAt });
      if (r.ok.length === 0) {
        const why = r.failed.map((f) => `${f.url}: ${f.reason}`).join("; ") || "no relays";
        throw new Error(`publish failed (${why})`);
      }
      results.push(r);
    }
    return results[results.length - 1]!;
  }
}

function randomFid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
