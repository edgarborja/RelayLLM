import { generateSecretKey, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { LocalSigner, type Signer } from "@relayllm/nostr-transport";

/**
 * Browser identity vault.
 *
 * - Local identity: the nsec is stored only as a NIP-49 `ncryptsec`
 *   (scrypt + XChaCha20-Poly1305) under a user password. Never in plaintext.
 * - NIP-07: the key stays in the browser extension.
 *
 * Either way, a random 256-bit data key encrypts local chat history. It is
 * stored NIP-44-encrypted to the user's own pubkey, so only the unlocked
 * identity can recover it.
 */

export type StoredIdentity =
  | { type: "local"; pubkey: string; ncryptsec: string; wrappedDataKey: string }
  | { type: "nip07"; pubkey: string; wrappedDataKey: string };

export interface UnlockedIdentity {
  stored: StoredIdentity;
  signer: Signer;
  dataKey: Uint8Array;
}

const STORAGE_KEY = "relayllm.identity.v1";
/** scrypt cost 2^16: ~0.3–1.5 s in browsers. */
const LOGN = 16;

export class WrongPasswordError extends Error {
  constructor() {
    super("Incorrect password");
  }
}

export function loadStoredIdentity(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredIdentity;
    if (!v || typeof v.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(v.pubkey) || typeof v.wrappedDataKey !== "string") return null;
    if (v.type === "local" && typeof v.ncryptsec === "string" && v.ncryptsec.startsWith("ncryptsec1")) return v;
    if (v.type === "nip07") return v;
    return null;
  } catch {
    return null;
  }
}

function save(stored: StoredIdentity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export function forgetIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
}

async function wrapNewDataKey(signer: Signer): Promise<{ dataKey: Uint8Array; wrapped: string }> {
  const dataKey = generateSecretKey(); // 32 random bytes
  const wrapped = await signer.nip44Encrypt(signer.pubkey, bytesToHex(dataKey));
  return { dataKey, wrapped };
}

async function unwrapDataKey(signer: Signer, wrapped: string): Promise<Uint8Array> {
  const hex = await signer.nip44Decrypt(signer.pubkey, wrapped);
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Corrupted data key");
  return hexToBytes(hex);
}

/** Parse an nsec (or 64-char hex) entered by the user. */
export function parseSecretKey(input: string): Uint8Array {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return hexToBytes(s.toLowerCase());
  const d = nip19.decode(s);
  if (d.type !== "nsec") throw new Error("Not an nsec");
  return d.data;
}

/** Yield to the browser so a "working…" state can paint before scrypt blocks. */
const yieldToUi = () => new Promise((r) => setTimeout(r, 30));

export async function createLocalIdentity(password: string, importKey?: Uint8Array): Promise<UnlockedIdentity> {
  if (password.length < 8) throw new Error("Use at least 8 characters");
  await yieldToUi();
  const sk = importKey ?? generateSecretKey();
  const signer = new LocalSigner(sk);
  const ncryptsec = nip49.encrypt(sk, password, LOGN, 0x02);
  const { dataKey, wrapped } = await wrapNewDataKey(signer);
  const stored: StoredIdentity = { type: "local", pubkey: getPublicKey(sk), ncryptsec, wrappedDataKey: wrapped };
  save(stored);
  return { stored, signer, dataKey };
}

export async function unlockLocal(stored: Extract<StoredIdentity, { type: "local" }>, password: string): Promise<UnlockedIdentity> {
  await yieldToUi();
  let sk: Uint8Array;
  try {
    sk = nip49.decrypt(stored.ncryptsec, password);
  } catch {
    throw new WrongPasswordError();
  }
  const signer = new LocalSigner(sk);
  if (signer.pubkey !== stored.pubkey) throw new Error("Stored identity is inconsistent");
  return { stored, signer, dataKey: await unwrapDataKey(signer, stored.wrappedDataKey) };
}

/** Export the nsec after re-entering the password. */
export async function revealNsec(stored: Extract<StoredIdentity, { type: "local" }>, password: string): Promise<string> {
  await yieldToUi();
  try {
    return nip19.nsecEncode(nip49.decrypt(stored.ncryptsec, password));
  } catch {
    throw new WrongPasswordError();
  }
}

// ---------------------------------------------------------------- NIP-07

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(e: EventTemplate): Promise<Event>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

function nip07(): Nip07 | null {
  return ((globalThis as { nostr?: Nip07 }).nostr as Nip07 | undefined) ?? null;
}

export function hasNip07(): boolean {
  return nip07() !== null;
}

export class Nip07Signer implements Signer {
  constructor(
    readonly pubkey: string,
    private readonly ext: Nip07,
  ) {}

  static async connect(): Promise<Nip07Signer> {
    const ext = nip07();
    if (!ext) throw new Error("No Nostr browser extension (NIP-07) found.");
    if (!ext.nip44) throw new Error("Your Nostr extension does not support NIP-44 encryption. Please update it or use a local identity.");
    const pk = await ext.getPublicKey();
    if (!/^[0-9a-f]{64}$/.test(pk)) throw new Error("Extension returned an invalid public key");
    return new Nip07Signer(pk, ext);
  }

  async signEvent(t: EventTemplate): Promise<Event> {
    const ev = await this.ext.signEvent(t);
    if (ev.pubkey !== this.pubkey) throw new Error("Extension signed with a different key");
    return ev;
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return this.ext.nip44!.encrypt(peer, plaintext);
  }

  nip44Decrypt(peer: string, payload: string): Promise<string> {
    return this.ext.nip44!.decrypt(peer, payload);
  }
}

export async function connectNip07(existing?: Extract<StoredIdentity, { type: "nip07" }>): Promise<UnlockedIdentity> {
  const signer = await Nip07Signer.connect();
  if (existing && existing.pubkey === signer.pubkey) {
    return { stored: existing, signer, dataKey: await unwrapDataKey(signer, existing.wrappedDataKey) };
  }
  if (existing && existing.pubkey !== signer.pubkey) {
    throw new Error("The extension is using a different account than the one saved here.");
  }
  const { dataKey, wrapped } = await wrapNewDataKey(signer);
  const stored: StoredIdentity = { type: "nip07", pubkey: signer.pubkey, wrappedDataKey: wrapped };
  save(stored);
  return { stored, signer, dataKey };
}
