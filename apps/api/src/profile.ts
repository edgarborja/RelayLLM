import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateSecretKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { normalizeRelayUrl, npubToHex } from "@relayllm/nostr-transport";
import { RelayLLMError } from "./errors.ts";

/** A worker to talk to and this program's own identity. Owner-only file. */
export interface Profile {
  version: 1;
  worker: string;
  relays: string[];
  name?: string;
  secretKey: string;
}

export const apiHome = () => process.env.RELAYLLM_API_HOME || join(homedir(), ".relayllm-api");

export function profilePath(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new RelayLLMError("no_profile", "Profile names use letters, digits, - and _.");
  return join(apiHome(), `${name}.json`);
}

export const newSecretKey = () => nip19.nsecEncode(generateSecretKey());

export function decodeSecretKey(key: string): Uint8Array {
  const s = key.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Uint8Array.from(Buffer.from(s, "hex"));
  try {
    const d = nip19.decode(s);
    if (d.type === "nsec") return d.data;
  } catch {
    /* handled below; never echo the key */
  }
  throw new RelayLLMError("no_profile", "The secret key is not a valid nsec or hex key.");
}

export function checkTarget(worker: string, relays: string[]): { workerPubkey: string; relays: string[] } {
  const workerPubkey = npubToHex(worker);
  if (!workerPubkey) throw new RelayLLMError("no_profile", "The worker is not a valid npub.");
  const ok = relays.map(normalizeRelayUrl).filter((r): r is string => !!r);
  if (ok.length === 0) throw new RelayLLMError("no_profile", "At least one relay URL (wss://…) is needed.");
  return { workerPubkey, relays: ok };
}

export function loadProfile(name: string): Profile | null {
  const path = profilePath(name);
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Profile;
    if (p.version === 1 && typeof p.worker === "string" && Array.isArray(p.relays) && typeof p.secretKey === "string") return p;
  } catch {
    /* handled below */
  }
  throw new RelayLLMError("no_profile", `${path} is not a valid profile.`);
}

export function saveProfile(name: string, profile: Profile): void {
  const path = profilePath(name);
  mkdirSync(apiHome(), { recursive: true, mode: 0o700 });
  chmodSync(apiHome(), 0o700);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
