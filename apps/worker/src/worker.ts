import { writeFileSync, renameSync } from "node:fs";
import { generateSecretKey } from "nostr-tools/pure";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { LocalSigner, NostrEndpoint, RelayPool, normalizeRelayUrl, type RelayStatus } from "@relayllm/nostr-transport";
import { createProvider, type ProviderAdapter, type ProviderHealth } from "@relayllm/provider-adapters";
import { authorize } from "./access.ts";
import { configMtime, loadConfig, relayllmHome, saveConfig, statusPath, type Config } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { createLogger, type Logger } from "./log.ts";
import { openSecretStore, SECRET_PROVIDER_KEY, SECRET_WORKER_KEY, type SecretStore } from "./secrets.ts";

export function loadOrCreateIdentity(store: SecretStore, create = true): LocalSigner | null {
  const hex = store.get(SECRET_WORKER_KEY);
  if (hex && /^[0-9a-f]{64}$/.test(hex)) return new LocalSigner(hexToBytes(hex));
  if (!create) return null;
  const sk = generateSecretKey();
  store.set(SECRET_WORKER_KEY, bytesToHex(sk));
  return new LocalSigner(sk);
}

export function buildProvider(cfg: Config, store: SecretStore | null): ProviderAdapter {
  const apiKey = cfg.provider.hasApiKey && store ? (store.get(SECRET_PROVIDER_KEY) ?? undefined) : undefined;
  return createProvider(cfg.provider.kind, {
    baseUrl: cfg.provider.baseUrl,
    apiKey,
    allowRemoteEndpoint: cfg.provider.allowRemoteEndpoint,
    streaming: cfg.provider.streaming,
  });
}

export interface WorkerStatus {
  pid: number;
  startedAt: number;
  updatedAt: number;
  pubkey: string;
  relays: RelayStatus[];
  provider: ProviderHealth & { kind: string };
  activeRequests: number;
}

export interface RunningWorker {
  pubkey: string;
  pool: RelayPool;
  gateway: Gateway;
  stop(): Promise<void>;
  status(): Promise<WorkerStatus>;
}

export interface StartOptions {
  home?: string;
  /** Inject for tests. */
  store?: SecretStore;
  provider?: ProviderAdapter;
  log?: Logger;
  /** Override config (tests): used instead of reading the file. */
  config?: Config;
  writeStatus?: boolean;
  pingIntervalMs?: number;
}

export async function startWorker(opts: StartOptions = {}): Promise<RunningWorker> {
  const home = opts.home ?? relayllmHome();
  const log = opts.log ?? createLogger();
  let cfg = opts.config ?? loadConfig(home);
  const fileBacked = !opts.config;
  const store = opts.store ?? openSecretStore(cfg.keyStorage, home);
  const signer = loadOrCreateIdentity(store, false);
  if (!signer) throw new Error('No worker identity found. Run "relayllm init" first.');
  const provider = opts.provider ?? buildProvider(cfg, store);

  const relays = cfg.relays.map(normalizeRelayUrl).filter((r): r is string => !!r);
  if (relays.length === 0) throw new Error("No valid relays configured");

  let lastStatusLog = "";
  const pool = new RelayPool(relays, {
    authSigner: (t) => signer.signEvent(t),
    pingIntervalMs: opts.pingIntervalMs,
    onStatus: (st) => {
      const summary = st.map((s) => `${s.url}=${s.state}`).join(" ");
      if (summary !== lastStatusLog) {
        lastStatusLog = summary;
        log.info("relays", { status: summary });
      }
    },
  });

  // Config reload (CLI edits while running), and persistence for gateway mutations.
  let mtime = fileBacked ? configMtime(home) : 0;
  const reload = () => {
    if (!fileBacked) return;
    const m = configMtime(home);
    if (m !== mtime) {
      try {
        cfg = loadConfig(home);
        mtime = m;
        log.info("configuration reloaded");
      } catch (e) {
        log.warn("config reload failed; keeping previous", { error: (e as Error).message });
      }
    }
  };
  const reloadTimer = setInterval(reload, 2000);

  const gateway = new Gateway({
    getConfig: () => cfg,
    mutateConfig: (fn) => {
      reload();
      fn(cfg);
      if (fileBacked) {
        saveConfig(cfg, home);
        mtime = configMtime(home);
      }
      return cfg;
    },
    provider,
    log,
    send: (to, message) => endpoint.send(to, message),
  });

  const endpoint: NostrEndpoint = new NostrEndpoint({
    pool,
    signer,
    onMessage: (m) => void gateway.handle(m).catch((e) => log.error("handler error", { error: (e as Error).message })),
    onDrop: (d) => log.debug("dropped event", { reason: d.reason }),
    // Only reassemble multi-event messages from senders allowed to send them.
    acceptFragmentsFrom: (sender) => authorize(cfg, sender) !== "denied",
  });
  endpoint.start();

  const startedAt = Date.now();
  let health: ProviderHealth = { ok: false, detail: "not checked yet" };
  const checkHealth = async () => {
    const prev = health.ok;
    health = await provider.health();
    if (health.ok !== prev) log.info(health.ok ? "provider reachable" : "provider unreachable", { detail: health.detail });
  };
  void checkHealth();
  const healthTimer = setInterval(() => void checkHealth(), 30_000);

  const status = async (): Promise<WorkerStatus> => ({
    pid: process.pid,
    startedAt,
    updatedAt: Date.now(),
    pubkey: signer.pubkey,
    relays: pool.status(),
    provider: { kind: provider.kind, ...health },
    activeRequests: gateway.activeCount,
  });
  const writeStatus = async () => {
    if (!(opts.writeStatus ?? fileBacked)) return;
    const p = statusPath(home);
    writeFileSync(`${p}.tmp`, JSON.stringify(await status(), null, 2), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
  };
  const statusTimer = setInterval(() => void writeStatus(), 5000);
  void writeStatus();

  return {
    pubkey: signer.pubkey,
    pool,
    gateway,
    status,
    async stop() {
      clearInterval(reloadTimer);
      clearInterval(healthTimer);
      clearInterval(statusTimer);
      gateway.shutdown();
      // Give cancellations a moment to publish completion events.
      await new Promise((r) => setTimeout(r, 300));
      endpoint.stop();
      pool.close();
    },
  };
}
