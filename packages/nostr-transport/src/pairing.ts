import * as nip19 from "nostr-tools/nip19";

/**
 * Pairing links: `<clientUrl>?worker=npub1...[&relay=wss://a&relay=wss://b][&name=Home]#invite=<token>`
 *
 * Relays are left out when they are exactly DEFAULT_RELAYS, which readers
 * then assume.
 *
 * Worker identity and relays go in the query string (not secret). The
 * optional single-use invite token goes in the URL fragment so it is never
 * sent to the static web host. Never contains private keys.
 */

export interface PairingInfo {
  workerPubkey: string;
  relays: string[];
  name?: string;
  invite?: string;
}

export const MAX_RELAYS = 8;

/** Relays both sides assume when a pairing link names none. Changing this breaks such links. */
export const DEFAULT_RELAYS: readonly string[] = ["wss://relay.k1.sv", "wss://nos.lol", "wss://relay.damus.io"];

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function npubToHex(npub: string): string | null {
  const s = npub.trim();
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  try {
    const d = nip19.decode(s);
    if (d.type === "npub") return d.data;
    if (d.type === "nprofile") return d.data.pubkey;
  } catch {
    /* invalid */
  }
  return null;
}

export const hexToNpub = (hex: string): string => nip19.npubEncode(hex);

/** Accept only ws:// or wss:// URLs without credentials. Returns normalized URL or null. */
export function normalizeRelayUrl(input: string): string | null {
  const raw = input.trim();
  if (raw.length > 256) return null;
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `wss://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  u.hash = "";
  let s = u.toString();
  if (s.endsWith("/") && u.pathname === "/" && !u.search) s = s.slice(0, -1);
  return s;
}

export function buildPairingUrl(clientUrl: string, info: PairingInfo): string {
  const u = new URL(clientUrl);
  u.searchParams.set("worker", hexToNpub(info.workerPubkey));
  const relays = info.relays.slice(0, MAX_RELAYS);
  if (!sameSet(relays, DEFAULT_RELAYS)) for (const r of relays) u.searchParams.append("relay", r);
  if (info.name) u.searchParams.set("name", info.name.slice(0, 64));
  if (info.invite) u.hash = `invite=${encodeURIComponent(info.invite)}`;
  return u.toString();
}

/** Parse untrusted pairing parameters. Returns null if no valid worker key. */
export function parsePairingUrl(url: string | URL): PairingInfo | null {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  const hashParams = new URLSearchParams(u.hash.replace(/^#/, ""));
  const get = (k: string) => u.searchParams.get(k) ?? hashParams.get(k);
  const worker = get("worker");
  if (!worker) return null;
  const workerPubkey = npubToHex(worker);
  if (!workerPubkey) return null;
  const relays = [...u.searchParams.getAll("relay"), ...hashParams.getAll("relay")]
    .map(normalizeRelayUrl)
    .filter((r): r is string => !!r);
  const name = get("name")?.replace(/[\u0000-\u001f]/g, "").slice(0, 64) || undefined;
  const inviteRaw = hashParams.get("invite") ?? u.searchParams.get("invite");
  const invite = inviteRaw && /^[A-Za-z0-9_-]{16,128}$/.test(inviteRaw) ? inviteRaw : undefined;
  const unique = [...new Set(relays)].slice(0, MAX_RELAYS);
  return { workerPubkey, relays: unique.length ? unique : [...DEFAULT_RELAYS], name, invite };
}
