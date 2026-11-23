import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";

/** Token-bucket rate limiter keyed by string. */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(
    private perMinute: number,
    private readonly burst = Math.max(1, perMinute),
    private readonly maxKeys = 10_000,
  ) {}

  setRate(perMinute: number): void {
    this.perMinute = perMinute;
  }

  /** Returns 0 if allowed, otherwise seconds until a token is available. */
  take(key: string, now = Date.now()): number {
    let b = this.#buckets.get(key);
    if (!b) {
      if (this.#buckets.size >= this.maxKeys) {
        const first = this.#buckets.keys().next().value;
        if (first !== undefined) this.#buckets.delete(first);
      }
      b = { tokens: this.burst, updated: now };
      this.#buckets.set(key, b);
    }
    const refill = ((now - b.updated) / 60_000) * this.perMinute;
    b.tokens = Math.min(this.burst, b.tokens + refill);
    b.updated = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) / this.perMinute) * 60);
  }
}

/** Fixed-window daily counter for public-mode quotas. */
export class DailyQuota {
  #day = "";
  readonly #counts = new Map<string, number>();
  take(key: string, limit: number, now = new Date()): boolean {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#counts.clear();
    }
    const n = this.#counts.get(key) ?? 0;
    if (n >= limit) return false;
    this.#counts.set(key, n + 1);
    return true;
  }
}

export type Authorization = "user" | "public" | "denied";

export function authorize(cfg: Config, pubkey: string): Authorization {
  if (cfg.access.users.some((u) => u.pubkey === pubkey)) return "user";
  if (cfg.access.mode === "public") return "public";
  return "denied";
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function newInviteToken(): string {
  return randomBytes(18).toString("base64url"); // 144 bits
}

/** Create a single-use invite. Returns the plaintext token (shown once). */
export function createInvite(cfg: Config, ttlSec: number, label?: string, now = Date.now()): string {
  const token = newInviteToken();
  cfg.access.invites = cfg.access.invites.filter((i) => i.expiresAt > now);
  cfg.access.invites.push({ hash: hashToken(token), expiresAt: now + ttlSec * 1000, label });
  return token;
}

/**
 * Validate and consume an invite. Mutates cfg (removes the invite and adds
 * the user). Returns true if the token was valid.
 */
export function redeemInvite(cfg: Config, token: string, pubkey: string, label?: string, now = Date.now()): boolean {
  const h = Buffer.from(hashToken(token), "hex");
  cfg.access.invites = cfg.access.invites.filter((i) => i.expiresAt > now);
  const idx = cfg.access.invites.findIndex((i) => {
    const b = Buffer.from(i.hash, "hex");
    return b.length === h.length && timingSafeEqual(b, h);
  });
  if (idx < 0) return false;
  const inv = cfg.access.invites[idx]!;
  cfg.access.invites.splice(idx, 1);
  addUser(cfg, pubkey, inv.label ?? label, now);
  return true;
}

export function addUser(cfg: Config, pubkey: string, label?: string, now = Date.now()): void {
  cfg.access.pending = cfg.access.pending.filter((p) => p.pubkey !== pubkey);
  if (!cfg.access.users.some((u) => u.pubkey === pubkey)) {
    cfg.access.users.push({ pubkey, label: label?.slice(0, 64), addedAt: now });
  }
}

export function removeUser(cfg: Config, pubkey: string): boolean {
  const before = cfg.access.users.length + cfg.access.pending.length;
  cfg.access.users = cfg.access.users.filter((u) => u.pubkey !== pubkey);
  cfg.access.pending = cfg.access.pending.filter((p) => p.pubkey !== pubkey);
  return cfg.access.users.length + cfg.access.pending.length < before;
}

export const MAX_PENDING = 50;

/** Record an access request for the owner to review. Bounded. */
export function addPending(cfg: Config, pubkey: string, label?: string, now = Date.now()): boolean {
  if (cfg.access.pending.some((p) => p.pubkey === pubkey)) return false;
  if (cfg.access.pending.length >= MAX_PENDING) cfg.access.pending.shift();
  cfg.access.pending.push({ pubkey, label: label?.replace(/[\u0000-\u001f]/g, "").slice(0, 64), requestedAt: now });
  return true;
}
