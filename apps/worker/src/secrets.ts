import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Local secret storage for the worker's Nostr key and provider API key.
 *
 * - KeychainStore: macOS login keychain via /usr/bin/security. Secrets are
 *   passed over stdin (`security -i`), never on the command line, so they
 *   don't show up in `ps`.
 * - FileStore: owner-only (0600) files in an owner-only (0700) directory.
 *
 * Values are hex-encoded so they never need shell/keychain quoting.
 */
export interface SecretStore {
  readonly kind: "keychain" | "file" | "memory";
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
}

const NAME = /^[a-z0-9-]{1,64}$/;
const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const fromHex = (h: string) => Buffer.from(h.trim(), "hex").toString("utf8");

export class FileStore implements SecretStore {
  readonly kind = "file" as const;
  constructor(private readonly dir: string) {}

  #path(name: string): string {
    if (!NAME.test(name)) throw new Error("invalid secret name");
    return join(this.dir, `${name}.secret`);
  }

  get(name: string): string | null {
    const p = this.#path(name);
    if (!existsSync(p)) return null;
    return fromHex(readFileSync(p, "utf8"));
  }

  set(name: string, value: string): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const p = this.#path(name);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, toHex(value), { mode: 0o600 });
    renameSync(tmp, p);
  }

  delete(name: string): void {
    rmSync(this.#path(name), { force: true });
  }
}

export class KeychainStore implements SecretStore {
  readonly kind = "keychain" as const;
  readonly #service: string;

  /** `scope` distinguishes multiple worker homes on one machine. */
  constructor(scope: string) {
    const h = createHash("sha256").update(scope).digest("hex").slice(0, 12);
    this.#service = `relayllm-${h}`;
  }

  static available(): boolean {
    return process.platform === "darwin" && existsSync("/usr/bin/security");
  }

  get(name: string): string | null {
    if (!NAME.test(name)) throw new Error("invalid secret name");
    const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", this.#service, "-a", name, "-w"], {
      encoding: "utf8",
    });
    if (r.status !== 0) return null;
    return fromHex(r.stdout);
  }

  set(name: string, value: string): void {
    if (!NAME.test(name)) throw new Error("invalid secret name");
    const cmd = `add-generic-password -U -s ${this.#service} -a ${name} -l "RelayLLM ${name}" -w ${toHex(value)}\n`;
    const r = spawnSync("/usr/bin/security", ["-i"], { input: cmd, encoding: "utf8" });
    if (r.status !== 0 || /error/i.test(r.stderr ?? "")) {
      throw new Error(`Keychain write failed (${(r.stderr || "").trim().slice(0, 200)})`);
    }
    if (this.get(name) !== value) throw new Error("Keychain write could not be verified");
  }

  delete(name: string): void {
    if (!NAME.test(name)) throw new Error("invalid secret name");
    spawnSync("/usr/bin/security", ["delete-generic-password", "-s", this.#service, "-a", name], { encoding: "utf8" });
  }
}

export class MemoryStore implements SecretStore {
  readonly kind = "memory" as const;
  readonly #m = new Map<string, string>();
  get(name: string) {
    return this.#m.get(name) ?? null;
  }
  set(name: string, value: string) {
    this.#m.set(name, value);
  }
  delete(name: string) {
    this.#m.delete(name);
  }
}

export function openSecretStore(kind: "keychain" | "file", home: string): SecretStore {
  if (kind === "keychain") {
    if (!KeychainStore.available()) throw new Error("macOS Keychain is not available; use keyStorage \"file\"");
    return new KeychainStore(home);
  }
  return new FileStore(join(home, "secrets"));
}

export const SECRET_WORKER_KEY = "worker-nsec";
export const SECRET_PROVIDER_KEY = "provider-api-key";
