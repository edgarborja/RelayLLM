import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";

/**
 * Minimal signing/decryption capability. Implemented by a local secret key
 * (worker, browser vault, per-session keys) or a NIP-07 browser extension.
 */
export interface Signer {
  /** Hex public key. */
  readonly pubkey: string;
  signEvent(template: EventTemplate): Promise<Event>;
  /** NIP-44 v2 decrypt of a payload sent by `peerPubkey` to this key. */
  nip44Decrypt(peerPubkey: string, payload: string): Promise<string>;
  /** NIP-44 v2 encrypt a payload to `peerPubkey`. */
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
}

export class LocalSigner implements Signer {
  readonly pubkey: string;
  readonly #sk: Uint8Array;

  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 32) throw new Error("secret key must be 32 bytes");
    this.#sk = secretKey;
    this.pubkey = getPublicKey(secretKey);
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    return finalizeEvent(template, this.#sk);
  }

  async nip44Decrypt(peerPubkey: string, payload: string): Promise<string> {
    return nip44.decrypt(payload, nip44.getConversationKey(this.#sk, peerPubkey));
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return nip44.encrypt(plaintext, nip44.getConversationKey(this.#sk, peerPubkey));
  }

  /** Avoid accidental serialization of the key. */
  toJSON(): { pubkey: string } {
    return { pubkey: this.pubkey };
  }
}
