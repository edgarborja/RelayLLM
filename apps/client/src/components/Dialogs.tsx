import { useState, type FormEvent, type ReactNode } from "react";
import { hexToNpub, normalizeRelayUrl, npubToHex, parsePairingUrl, type PairingInfo } from "@relayllm/nostr-transport";
import type { WorkerProfile } from "../lib/db.ts";
import { revealDeviceNsec, revealNsec, type StoredIdentity } from "../lib/identity.ts";
import { CopyButton } from "./Markdown.tsx";
import { IconTrash, IconX } from "./icons.tsx";

export const DEFAULT_RELAYS = ["wss://relay.k1.sv", "wss://nos.lol"];

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function AddWorkerDialog({
  initial,
  onAdd,
  onClose,
}: {
  initial?: PairingInfo;
  onAdd: (profile: WorkerProfile, invite?: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(initial ? hexToNpub(initial.workerPubkey) : "");
  const [relays, setRelays] = useState((initial?.relays.length ? initial.relays : DEFAULT_RELAYS).join("\n"));
  const [name, setName] = useState(initial?.name ?? "");
  const [invite, setInvite] = useState(initial?.invite);
  const [error, setError] = useState<string | null>(null);

  // Accept a pasted pairing link in the npub box.
  const onInput = (v: string) => {
    setInput(v);
    if (/^https?:\/\//.test(v.trim())) {
      const p = parsePairingUrl(v.trim());
      if (p) {
        setInput(hexToNpub(p.workerPubkey));
        if (p.relays.length) setRelays(p.relays.join("\n"));
        if (p.name) setName(p.name);
        setInvite(p.invite);
      }
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pubkey = npubToHex(input);
    if (!pubkey) return setError("Enter a valid worker npub or pairing link.");
    const rs = relays
      .split(/[\s,]+/)
      .map((r) => normalizeRelayUrl(r))
      .filter((r): r is string => !!r);
    if (!rs.length) return setError("Add at least one relay (wss://…).");
    if (invite && !/^[A-Za-z0-9_-]{16,128}$/.test(invite)) return setError("That invite code is not valid.");
    onAdd({ id: pubkey, name: name.trim().slice(0, 64) || "My worker", relays: [...new Set(rs)].slice(0, 8), addedAt: Date.now() }, invite);
  };

  return (
    <Modal title="Add a worker" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Worker npub or pairing link</span>
          <input autoFocus spellCheck={false} value={input} onChange={(e) => onInput(e.target.value)} placeholder="npub1… or https://…?worker=npub1…" />
        </label>
        <label className="field">
          <span>Display name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Home Mac Mini" maxLength={64} />
        </label>
        <label className="field">
          <span>Relays (one per line)</span>
          <textarea rows={3} spellCheck={false} value={relays} onChange={(e) => setRelays(e.target.value)} />
        </label>
        {initial?.invite ? (
          <p className="small ok-text">This link includes a one-time invitation; access will be granted automatically.</p>
        ) : (
          <label className="field">
            <span>Invite code (optional)</span>
            <input spellCheck={false} autoComplete="off" value={invite ?? ""} onChange={(e) => setInvite(e.target.value.trim() || undefined)} placeholder="From relayllm pair --invite" />
          </label>
        )}
        <p className="small muted">Run <code>relayllm pair</code> on the worker machine to see its npub, relays and a QR code.</p>
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Add worker</button>
        </div>
      </form>
    </Modal>
  );
}

export type ThemePref = "system" | "light" | "dark";

export function SettingsDialog(props: {
  identity: StoredIdentity;
  workers: WorkerProfile[];
  theme: ThemePref;
  defaultPromptName: string;
  onTheme: (t: ThemePref) => void;
  onManagePrompts: () => void;
  onRenameWorker: (w: WorkerProfile, name: string) => void;
  onRemoveWorker: (w: WorkerProfile) => void;
  onDeleteHistory: () => void;
  onLock: () => void;
  onForget: () => void;
  onClose: () => void;
}) {
  const npub = hexToNpub(props.identity.pubkey);
  const [revealPw, setRevealPw] = useState("");
  const [nsec, setNsec] = useState<string | null>(null);
  const [revealErr, setRevealErr] = useState<string | null>(null);

  return (
    <Modal title="Settings" onClose={props.onClose}>
      <div className="stack settings">
        <section>
          <h3>Your identity</h3>
          <div className="identity-line">
            <span className="mono ellipsis">{npub}</span>
            <CopyButton text={npub} label="Copy npub" />
          </div>
          <p className="small muted">
            {props.identity.type === "device"
              ? "Kept by this browser, without a password. Anyone using this browser profile can use it; clearing the site's data removes it."
              : props.identity.type === "local"
                ? "Local key, encrypted with your password."
                : "Managed by your Nostr browser extension."}{" "}
            Give this npub to a worker owner to get access.
          </p>
          {props.identity.type === "device" && !nsec && (
            <button
              className="btn small"
              onClick={() => {
                const stored = props.identity;
                if (stored.type === "device") revealDeviceNsec(stored).then(setNsec, (e: Error) => setRevealErr(e.message));
              }}
            >
              Show nsec (backup)
            </button>
          )}
          {props.identity.type === "device" && nsec && (
            <div className="secret-box">
              <span className="mono ellipsis">{nsec}</span>
              <CopyButton text={nsec} label="Copy nsec" />
              <button className="btn small ghost" onClick={() => setNsec(null)}>
                Hide
              </button>
            </div>
          )}
          {props.identity.type === "local" &&
            (nsec ? (
              <div className="secret-box">
                <span className="mono ellipsis">{nsec}</span>
                <CopyButton text={nsec} label="Copy nsec" />
                <button className="btn small ghost" onClick={() => setNsec(null)}>
                  Hide
                </button>
              </div>
            ) : (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const stored = props.identity;
                  if (stored.type !== "local") return;
                  revealNsec(stored, revealPw)
                    .then((s) => {
                      setNsec(s);
                      setRevealErr(null);
                      setRevealPw("");
                    })
                    .catch(() => setRevealErr("Incorrect password"));
                }}
              >
                <input type="password" placeholder="Password to back up your nsec" value={revealPw} onChange={(e) => setRevealPw(e.target.value)} />
                <button className="btn small">Reveal nsec</button>
              </form>
            ))}
          {revealErr && <p className="error-text">{revealErr}</p>}
          <div className="row">
            {props.identity.type !== "device" && (
              <button className="btn small" onClick={props.onLock}>
                Lock
              </button>
            )}
            <button className="btn small ghost danger-text" onClick={props.onForget}>
              Sign out &amp; remove identity
            </button>
          </div>
        </section>

        <section>
          <h3>Appearance</h3>
          <div className="segmented" role="radiogroup">
            {(["system", "light", "dark"] as const).map((t) => (
              <button key={t} role="radio" aria-checked={props.theme === t} className={props.theme === t ? "active" : ""} onClick={() => props.onTheme(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>System prompts</h3>
          <div className="row">
            <span className="small">
              Default for new chats: <strong>{props.defaultPromptName}</strong>
            </span>
            <div className="spacer" />
            <button className="btn small" onClick={props.onManagePrompts}>
              Manage…
            </button>
          </div>
        </section>

        <section>
          <h3>Workers</h3>
          {props.workers.length === 0 && <p className="small muted">No workers yet.</p>}
          {props.workers.map((w) => (
            <div key={w.id} className="worker-row">
              <input defaultValue={w.name} aria-label="Worker name" onBlur={(e) => e.target.value.trim() && e.target.value !== w.name && props.onRenameWorker(w, e.target.value.trim())} />
              <span className="mono small muted ellipsis" title={w.relays.join(", ")}>
                {hexToNpub(w.id).slice(0, 16)}… · {w.relays.length} relay{w.relays.length === 1 ? "" : "s"}
              </span>
              <button className="icon-btn" aria-label={`Remove ${w.name}`} onClick={() => props.onRemoveWorker(w)}>
                <IconTrash />
              </button>
            </div>
          ))}
        </section>

        <section>
          <h3>Local data</h3>
          <p className="small muted">
            Conversations are stored only in this browser, encrypted with a key unlocked by your identity. Nothing is stored on any server.
          </p>
          <button className="btn small danger" onClick={props.onDeleteHistory}>
            Delete all conversation history
          </button>
        </section>
      </div>
    </Modal>
  );
}
