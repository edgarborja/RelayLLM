import { useState, type FormEvent } from "react";
import {
  connectNip07,
  createLocalIdentity,
  forgetIdentity,
  hasNip07,
  parseSecretKey,
  unlockLocal,
  WrongPasswordError,
  type StoredIdentity,
  type UnlockedIdentity,
} from "../lib/identity.ts";
import { hexToNpub } from "@relayllm/nostr-transport";
import { IconLock } from "./icons.tsx";

type Mode = "choose" | "create" | "import";

export function Onboarding({
  stored,
  onUnlocked,
  pairingName,
}: {
  stored: StoredIdentity | null;
  onUnlocked: (u: UnlockedIdentity) => void;
  pairingName?: string;
}) {
  const [mode, setMode] = useState<Mode>("choose");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
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

  const brand = (
    <div className="brand-hero">
      <div className="logo-mark" aria-hidden>
        R
      </div>
      <h1>RelayLLM</h1>
      <p className="muted">Private AI on your own hardware, reachable from anywhere through encrypted Nostr messages.</p>
      {pairingName && <p className="pill">Pairing with “{pairingName}” after you sign in</p>}
    </div>
  );

  // ---------------- unlock an existing identity
  if (stored) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (stored.type === "local") void run(() => unlockLocal(stored, password));
      else void run(() => connectNip07(stored));
    };
    return (
      <div className="center-screen">
        <form className="card auth-card" onSubmit={submit}>
          {brand}
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
        </form>
      </div>
    );
  }

  // ---------------- first run
  if (mode === "choose") {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          {brand}
          <p className="small muted">You need a Nostr identity. Workers authorize you by its public key (npub).</p>
          <button className="btn primary wide" onClick={() => setMode("create")}>
            Create a new identity
          </button>
          <button className="btn wide" onClick={() => setMode("import")}>
            Import an existing nsec
          </button>
          <button className="btn wide" disabled={!hasNip07() || busy} onClick={() => void run(() => connectNip07())} title={hasNip07() ? "" : "No NIP-07 extension detected"}>
            Use Nostr browser extension{hasNip07() ? "" : " (not detected)"}
          </button>
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== password2) {
      setError("Passwords do not match.");
      return;
    }
    if (mode === "import") {
      let key: Uint8Array;
      try {
        key = parseSecretKey(nsec);
      } catch {
        setError("That does not look like a valid nsec.");
        return;
      }
      setNsec("");
      void run(() => createLocalIdentity(password, key));
    } else {
      void run(() => createLocalIdentity(password));
    }
  };

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        {brand}
        <h2>{mode === "create" ? "Create identity" : "Import identity"}</h2>
        {mode === "import" && (
          <label className="field">
            <span>nsec</span>
            <input type="password" autoComplete="off" spellCheck={false} value={nsec} onChange={(e) => setNsec(e.target.value)} placeholder="nsec1…" />
          </label>
        )}
        <label className="field">
          <span>Password (protects your key in this browser)</span>
          <input type="password" autoFocus autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="field">
          <span>Repeat password</span>
          <input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
        </label>
        <p className="small muted">
          The key is encrypted with your password (NIP-49) and stored only in this browser. There is no account recovery — if you forget the password,
          create a new identity and ask the worker owner to authorize it.
        </p>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary wide" disabled={busy || password.length < 8}>
          {busy ? "Encrypting…" : mode === "create" ? "Create identity" : "Import"}
        </button>
        <button type="button" className="btn ghost wide" onClick={() => setMode("choose")}>
          Back
        </button>
      </form>
    </div>
  );
}
