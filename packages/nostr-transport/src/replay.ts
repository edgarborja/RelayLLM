/**
 * Rejects stale, future-dated and previously seen inner events.
 *
 * An event is accepted only if created_at is within [now - maxAge, now + maxSkew]
 * and its id has not been seen within that window. Ids are remembered for
 * maxAge + maxSkew, after which the timestamp check alone rejects them.
 */
export class ReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #maxAgeSec: number;
  readonly #maxSkewSec: number;
  readonly #maxEntries: number;

  constructor(opts: { maxAgeSec?: number; maxSkewSec?: number; maxEntries?: number } = {}) {
    this.#maxAgeSec = opts.maxAgeSec ?? 120;
    this.#maxSkewSec = opts.maxSkewSec ?? 30;
    this.#maxEntries = opts.maxEntries ?? 100_000;
  }

  check(id: string, createdAt: number, now = Math.floor(Date.now() / 1000)): "ok" | "stale" | "future" | "replay" {
    if (createdAt < now - this.#maxAgeSec) return "stale";
    if (createdAt > now + this.#maxSkewSec) return "future";
    this.#prune(now);
    if (this.#seen.has(id)) return "replay";
    if (this.#seen.size >= this.#maxEntries) {
      // Bounded memory: evict oldest insertion (Map preserves order).
      const first = this.#seen.keys().next().value;
      if (first !== undefined) this.#seen.delete(first);
    }
    this.#seen.set(id, now + this.#maxAgeSec + this.#maxSkewSec);
    return "ok";
  }

  #lastPrune = 0;
  #prune(now: number): void {
    if (now === this.#lastPrune) return;
    this.#lastPrune = now;
    for (const [id, until] of this.#seen) {
      if (until < now) this.#seen.delete(id);
    }
  }

  get size(): number {
    return this.#seen.size;
  }
}

/** Small LRU set for de-duplicating identical outer events from many relays. */
export class SeenSet {
  readonly #set = new Set<string>();
  constructor(private readonly max = 10_000) {}
  /** Returns true if newly added, false if already present. */
  add(id: string): boolean {
    if (this.#set.has(id)) return false;
    this.#set.add(id);
    if (this.#set.size > this.max) {
      const first = this.#set.values().next().value;
      if (first !== undefined) this.#set.delete(first);
    }
    return true;
  }
}
