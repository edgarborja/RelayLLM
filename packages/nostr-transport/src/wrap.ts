import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import type { Signer } from "./signer.ts";

/**
 * Wire format (modelled on NIP-59 gift wrap and ContextVM CEP-4/CEP-19):
 *
 *   outer  kind 21059 (ephemeral gift wrap), signed by a fresh random key,
 *          tags: ["p", recipient], ["expiration", exp]
 *          content: NIP-44 v2( JSON(inner), randomKey ↔ recipient )
 *
 *   inner  kind 25920, signed by the sender's real key,
 *          tags: ["p", recipient]  (binds the message to one recipient)
 *          content: JSON application message (@relayllm/protocol)
 *
 * Relays see only: a random pubkey, the recipient pubkey, size, and timing.
 * The inner signature authenticates the sender; the inner "p" tag prevents a
 * captured message from being re-wrapped and replayed to another recipient.
 */
export const WRAP_KIND = 21059;
export const INNER_KIND = 25920;

/** Upper bound on the UTF-8 size of a serialized inner event. Keeps outer
 * events (~4/3 base64 expansion + JSON) well below common relay limits. */
export const DEFAULT_MAX_INNER_BYTES = 32_000;
/** NIP-44 v2 plaintext hard limit. */
export const NIP44_MAX_PLAINTEXT = 65_535;
/** Reject outer payloads larger than this before attempting decryption. */
export const MAX_OUTER_CONTENT = 200_000;

export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

export async function signInner(
  signer: Signer,
  recipient: string,
  content: string,
  createdAt = Math.floor(Date.now() / 1000),
): Promise<Event> {
  return signer.signEvent({
    kind: INNER_KIND,
    created_at: createdAt,
    tags: [["p", recipient]],
    content,
  });
}

export function wrapInner(inner: Event, recipient: string, expiresAt: number): Event {
  const plaintext = JSON.stringify(inner);
  if (utf8Length(plaintext) > NIP44_MAX_PLAINTEXT) throw new Error("inner event too large to wrap");
  const ephemeral = generateSecretKey();
  const content = nip44.encrypt(plaintext, nip44.getConversationKey(ephemeral, recipient));
  return finalizeEvent(
    {
      kind: WRAP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", recipient],
        ["expiration", String(expiresAt)],
      ],
      content,
    },
    ephemeral,
  );
}

export interface Unwrapped {
  /** Authenticated sender (inner event signer). */
  sender: string;
  /** Our key the message was addressed to. */
  recipient: string;
  innerId: string;
  createdAt: number;
  content: string;
}

export class UnwrapError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Verify and decrypt a wrapped event. Throws UnwrapError on any failure.
 * Replay/freshness checks are the caller's job (see ReplayGuard).
 */
export async function unwrap(outer: Event, recipients: Map<string, Signer>): Promise<Unwrapped> {
  if (outer.kind !== WRAP_KIND) throw new UnwrapError("wrong kind");
  if (typeof outer.content !== "string" || outer.content.length > MAX_OUTER_CONTENT) {
    throw new UnwrapError("payload too large");
  }
  const pTags = outer.tags.filter((t) => t[0] === "p");
  if (pTags.length !== 1) throw new UnwrapError("expected exactly one recipient");
  const recipient = pTags[0]![1]!;
  const signer = recipients.get(recipient);
  if (!signer) throw new UnwrapError("not addressed to us");
  const outerCopy: Event = {
    id: outer.id,
    pubkey: outer.pubkey,
    created_at: outer.created_at,
    kind: outer.kind,
    tags: outer.tags,
    content: outer.content,
    sig: outer.sig,
  };
  if (!verifyEvent(outerCopy)) throw new UnwrapError("bad outer signature");

  let plaintext: string;
  try {
    plaintext = await signer.nip44Decrypt(outer.pubkey, outer.content);
  } catch {
    throw new UnwrapError("decryption failed");
  }

  let inner: Event;
  try {
    inner = JSON.parse(plaintext) as Event;
  } catch {
    throw new UnwrapError("inner not JSON");
  }
  if (
    typeof inner !== "object" ||
    inner === null ||
    inner.kind !== INNER_KIND ||
    typeof inner.pubkey !== "string" ||
    !HEX64.test(inner.pubkey) ||
    typeof inner.content !== "string" ||
    !Array.isArray(inner.tags) ||
    typeof inner.created_at !== "number"
  ) {
    throw new UnwrapError("malformed inner event");
  }
  // Fresh copy so nostr-tools' verification cache can't be pre-seeded.
  const candidate: Event = {
    id: inner.id,
    pubkey: inner.pubkey,
    created_at: inner.created_at,
    kind: inner.kind,
    tags: inner.tags,
    content: inner.content,
    sig: inner.sig,
  };
  if (!verifyEvent(candidate)) throw new UnwrapError("bad inner signature");
  const innerP = candidate.tags.filter((t) => t[0] === "p");
  if (innerP.length !== 1 || innerP[0]![1] !== recipient) {
    throw new UnwrapError("inner recipient mismatch");
  }
  return {
    sender: candidate.pubkey,
    recipient,
    innerId: candidate.id,
    createdAt: candidate.created_at,
    content: candidate.content,
  };
}
