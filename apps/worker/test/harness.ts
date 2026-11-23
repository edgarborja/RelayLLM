import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LocalSigner, NostrEndpoint, RelayPool, WorkerClient, type IncomingMessage } from "@relayllm/nostr-transport";
import { parseWorkerMessage, type WorkerMessage } from "@relayllm/protocol";
import { MockProvider, MockRelay, type MockProviderOptions, type MockRelayOptions } from "@relayllm/test-utils";
import { defaultConfig, type Config } from "../src/config.ts";
import { silentLogger, createLogger } from "../src/log.ts";
import { MemoryStore, SECRET_WORKER_KEY } from "../src/secrets.ts";
import { buildProvider, startWorker, type RunningWorker } from "../src/worker.ts";

export interface Harness {
  relay: MockRelay;
  provider: MockProvider;
  worker: RunningWorker;
  config: Config;
  newUser(authorized?: boolean): LocalSigner;
  client(user: LocalSigner, opts?: Partial<ConstructorParameters<typeof WorkerClient>[0]>): WorkerClient;
  /** Raw endpoint for crafting arbitrary messages. Collects replies. */
  raw(user: LocalSigner): { endpoint: NostrEndpoint; replies: WorkerMessage[]; pool: RelayPool };
  close(): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];

export async function makeHarness(
  opts: {
    relay?: MockRelayOptions;
    provider?: MockProviderOptions;
    config?: (c: Config) => void;
    relayInstance?: MockRelay;
  } = {},
): Promise<Harness> {
  const relay = opts.relayInstance ?? (await MockRelay.start(opts.relay));
  const provider = await MockProvider.start(opts.provider);
  const config = defaultConfig({
    name: "Test Worker",
    keyStorage: "file",
    provider: { kind: "lmstudio", baseUrl: provider.baseUrl, allowRemoteEndpoint: false, streaming: true, hasApiKey: false },
    models: { exposed: ["mock-llm-small", "mock-llm-large"], manual: [] },
    relays: [relay.url],
  });
  config.streaming.batchMs = 50;
  opts.config?.(config);
  const store = new MemoryStore();
  store.set(SECRET_WORKER_KEY, bytesToHex(generateSecretKey()));
  const worker = await startWorker({
    config,
    store,
    provider: buildProvider(config, store),
    log: process.env.TEST_LOG ? createLogger("debug") : silentLogger,
    writeStatus: false,
  });
  await waitFor(() => worker.pool.connectedCount > 0);
  await sleep(50);
  const pools: RelayPool[] = [];
  const clients: WorkerClient[] = [];

  const h: Harness = {
    relay,
    provider,
    worker,
    config,
    newUser(authorized = true) {
      const u = new LocalSigner(generateSecretKey());
      if (authorized) config.access.users.push({ pubkey: u.pubkey, addedAt: Date.now() });
      return u;
    },
    client(user, extra = {}) {
      const authKey = new LocalSigner(generateSecretKey());
      const pool = new RelayPool([relay.url], {
        reconnectBaseMs: 100,
        reconnectMaxMs: 500,
        authSigner: (t) => authKey.signEvent(t),
      });
      pools.push(pool);
      const c = new WorkerClient({
        pool,
        identity: user,
        workerPubkey: worker.pubkey,
        requestTimeoutMs: 4000,
        resumeAfterMs: 400,
        ...extra,
      });
      clients.push(c);
      let connected = false;
      pool.opts.onStatus = () => {
        const now = pool.connectedCount > 0;
        if (now !== connected) {
          connected = now;
          c.onConnectivity(now);
        }
      };
      c.start();
      return c;
    },
    raw(user) {
      const pool = new RelayPool([relay.url]);
      pools.push(pool);
      const replies: WorkerMessage[] = [];
      const endpoint = new NostrEndpoint({
        pool,
        signer: user,
        onMessage: (m: IncomingMessage) => {
          const p = parseWorkerMessage(m.payload);
          if (p.ok) replies.push(p.message);
        },
      });
      endpoint.start();
      return { endpoint, replies, pool };
    },
    async close() {
      for (const c of clients) c.stop();
      for (const p of pools) p.close();
      await worker.stop();
      await provider.close();
      if (!opts.relayInstance) await relay.close();
    },
  };
  cleanups.push(() => h.close());
  return h;
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the relay pool has connected and subscriptions are live. */
export async function connected(pool: RelayPool): Promise<void> {
  await waitFor(() => pool.connectedCount > 0);
  await sleep(50);
}
