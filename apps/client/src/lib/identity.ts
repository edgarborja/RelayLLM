import { generateSecretKey, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { openDB } from "idb";
import { LocalSigner, type Signer } from "@relayllm/nostr-transport";

/**
 * Browser identity vault.
 *
 * - Device identity (the default): no password. The nsec is encrypted with
 *   a non-extractable AES-GCM key that only this browser profile can use,
 *   held in IndexedDB. It unlocks automatically, so it protects against
 *   copies of the stored data, not against someone using this browser.
 * - Local identity (older): the nsec is stored only as a NIP-49 `ncryptsec`
 *   (scrypt + XChaCha20-Poly1305) under a user password. Never in plaintext.
 * - NIP-07: the key stays in the browser extension.
 *
 * Either way, a random 256-bit data key encrypts local chat history. It is
 * stored NIP-44-encrypted to the user's own pubkey, so only the unlocked
 * identity can recover it.
 */

export type StoredIdentity =
  | { type: "device"; pubkey: string; sealedKey: string; wrappedDataKey: string }
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
    if (v.type === "device" && typeof v.sealedKey === "string") return v;
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
  void deviceKeyDb().then((db) => db.delete("keys", "device")).catch(() => undefined);
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

// ---------------------------------------------------------------- device

const deviceKeyDb = () => openDB("relayllm-device-key", 1, { upgrade: (d) => void d.createObjectStore("keys") });

/** This browser's non-extractable sealing key; created on first use. */
async function deviceKey(create: boolean): Promise<CryptoKey | null> {
  const db = await deviceKeyDb();
  try {
    const existing = (await db.get("keys", "device")) as CryptoKey | undefined;
    if (existing || !create) return existing ?? null;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await db.put("keys", key, "device");
    return key;
  } finally {
    db.close();
  }
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const SEAL_AD = new TextEncoder().encode("relayllm-device-identity");

/** Create an identity kept by this browser, with no password. */
export async function createDeviceIdentity(importKey?: Uint8Array): Promise<UnlockedIdentity> {
  const key = await deviceKey(true);
  const sk = importKey ?? generateSecretKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: SEAL_AD }, key!, sk as BufferSource));
  const signer = new LocalSigner(sk);
  const { dataKey, wrapped } = await wrapNewDataKey(signer);
  const stored: StoredIdentity = { type: "device", pubkey: signer.pubkey, sealedKey: `${b64(iv)}.${b64(ct)}`, wrappedDataKey: wrapped };
  save(stored);
  return { stored, signer, dataKey };
}

async function openDeviceKey(stored: Extract<StoredIdentity, { type: "device" }>): Promise<Uint8Array> {
  const key = await deviceKey(false);
  if (!key) throw new Error("This browser no longer has the key for this identity (its site data was cleared).");
  const [iv, ct] = stored.sealedKey.split(".");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv!), additionalData: SEAL_AD }, key, unb64(ct!)));
  } catch {
    throw new Error("The identity stored in this browser could not be opened.");
  }
}

export async function unlockDevice(stored: Extract<StoredIdentity, { type: "device" }>): Promise<UnlockedIdentity> {
  const signer = new LocalSigner(await openDeviceKey(stored));
  if (signer.pubkey !== stored.pubkey) throw new Error("Stored identity is inconsistent");
  return { stored, signer, dataKey: await unwrapDataKey(signer, stored.wrappedDataKey) };
}

/** For backups. */
export async function revealDeviceNsec(stored: Extract<StoredIdentity, { type: "device" }>): Promise<string> {
  return nip19.nsecEncode(await openDeviceKey(stored));
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
