import { useEffect, useState, type FormEvent } from "react";
import {
  connectNip07,
  createDeviceIdentity,
  forgetIdentity,
  hasNip07,
  parseSecretKey,
  unlockDevice,
  unlockLocal,
  WrongPasswordError,
  type StoredIdentity,
  type UnlockedIdentity,
} from "../lib/identity.ts";
import { hexToNpub } from "@relayllm/nostr-transport";
import { IconLock } from "./icons.tsx";

type Mode = "choose" | "import";

/**
 * Opening or creating an identity without user input happens once per page
 * load, even if React mounts this twice.
 */
let automatic: Promise<UnlockedIdentity> | null = null;
let started = false;

export function Onboarding({
  stored,
  onUnlocked,
  fromInvite,
}: {
  stored: StoredIdentity | null;
  onUnlocked: (u: UnlockedIdentity) => void;
  /** Opened from a pairing link: set up without asking anything. */
  fromInvite: boolean;
}) {
  const auto = stored?.type === "device" || (!stored && fromInvite);
  const [mode, setMode] = useState<Mode>("choose");
  const [password, setPassword] = useState("");
  const [nsec, setNsec] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<UnlockedIdentity>) => {
    setBusy(true);
    setError(null);
    try {
      onUnlocked(await fn());
    } catch (e) {
      setError(e instanceof WrongPasswordError ? "Incorrect password." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!auto || started) return;
    started = true;
    automatic ??= stored?.type === "device" ? unlockDevice(stored) : createDeviceIdentity();
    void run(() => automatic!);
    // Once, on mount.
  }, []);

  const startOver = (
    <button
      type="button"
      className="btn ghost wide danger-text"
      onClick={() => {
        if (confirm("Remove this identity from this browser? Local chats encrypted with it become unreadable unless you sign in with the same key again.")) {
          forgetIdentity();
          location.reload();
        }
      }}
    >
      Use a different identity
    </button>
  );

  const brand = (
    <div className="brand-hero">
      <div className="logo-mark" aria-hidden>
        R
      </div>
      <h1>RelayLLM</h1>
      <p className="muted">Private AI on your own hardware, reachable from anywhere through encrypted Nostr messages.</p>
    </div>
  );

  // ---------------- opened or created without asking
  if (auto) {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          {brand}
          {error ? (
            <>
              <p className="error-text">{error}</p>
              {stored ? startOver : <button className="btn primary wide" onClick={() => location.reload()}>Try again</button>}
            </>
          ) : (
            <p className="muted center" aria-live="polite">
              {stored ? "Opening…" : "Setting up…"}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---------------- unlock an older password-protected identity, or an extension
  if (stored) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (stored.type === "local") void run(() => unlockLocal(stored, password));
      else if (stored.type === "nip07") void run(() => connectNip07(stored));
    };
    return (
      <div className="center-screen">
        <form className="card auth-card" onSubmit={submit}>
          {brand}
          {fromInvite && <p className="pill">The invitation is applied once you unlock.</p>}
          <div className="identity-line">
            <IconLock />
            <span className="mono ellipsis">{hexToNpub(stored.pubkey)}</span>
          </div>
          {stored.type === "local" ? (
            <label className="field">
              <span>Password</span>
              <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          ) : (
            <p className="muted small">This identity is held by your Nostr browser extension.</p>
          )}
          {error && <p className="error-text">{error}</p>}
          <button className="btn primary wide" disabled={busy || (stored.type === "local" && !password)}>
            {busy ? "Unlocking…" : stored.type === "local" ? "Unlock" : "Connect extension"}
          </button>
          {startOver}
        </form>
      </div>
    );
  }

  // ---------------- first run without an invitation
  if (mode === "choose") {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          {brand}
          <p className="small muted">You need a Nostr identity. Workers authorize you by its public key (npub).</p>
          <button className="btn primary wide" disabled={busy} onClick={() => void run(() => createDeviceIdentity())}>
            Create a new identity
          </button>
          <button className="btn wide" onClick={() => setMode("import")}>
            Import an existing nsec
          </button>
          <button className="btn wide" disabled={!hasNip07() || busy} onClick={() => void run(() => connectNip07())} title={hasNip07() ? "" : "No NIP-07 extension detected"}>
            Use Nostr browser extension{hasNip07() ? "" : " (not detected)"}
          </button>
          <p className="small muted">The key is kept by this browser; there is no password. Back it up from Settings if you want to use it elsewhere.</p>
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let key: Uint8Array;
    try {
      key = parseSecretKey(nsec);
    } catch {
      setError("That does not look like a valid nsec.");
      return;
    }
    setNsec("");
    void run(() => createDeviceIdentity(key));
  };

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        {brand}
        <h2>Import identity</h2>
        <label className="field">
          <span>nsec</span>
          <input type="password" autoFocus autoComplete="off" spellCheck={false} value={nsec} onChange={(e) => setNsec(e.target.value)} placeholder="nsec1…" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary wide" disabled={busy || !nsec.trim()}>
          Import
        </button>
        <button type="button" className="btn ghost wide" onClick={() => setMode("choose")}>
          Back
        </button>
      </form>
    </div>
  );
}
