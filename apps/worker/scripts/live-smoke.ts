/**
 * Live smoke test: runs a worker against a real local engine and a real
 * relay, then chats with it through the relay as an authorized user.
 *
 *   PROVIDER_URL=http://localhost:1235/v1 RELAY=wss://relay.k1.sv MODEL=qwen/qwen3.5-9b \
 *     pnpm tsx apps/worker/scripts/live-smoke.ts
 */
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LocalSigner, RelayPool, WorkerClient } from "@relayllm/nostr-transport";
import { defaultConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { MemoryStore, SECRET_WORKER_KEY } from "../src/secrets.ts";
import { buildProvider, startWorker } from "../src/worker.ts";

const providerUrl = process.env.PROVIDER_URL ?? "http://localhost:1235/v1";
const relayUrl = process.env.RELAY ?? "wss://relay.k1.sv";
const model = process.env.MODEL ?? "qwen/qwen3.5-9b";
const prompt = process.env.PROMPT ?? "In two sentences, what is Nostr?";

const user = new LocalSigner(generateSecretKey());
const cfg = defaultConfig({ name: "Live smoke", keyStorage: "file", relays: [relayUrl] });
cfg.provider = { ...cfg.provider, kind: "lmstudio", baseUrl: providerUrl, allowRemoteEndpoint: false, streaming: true, hasApiKey: false };
cfg.monitoring.host = process.env.HOST_METRICS !== "0";
cfg.models.exposed = [model];
cfg.access.users.push({ pubkey: user.pubkey, addedAt: Date.now() });
cfg.limits.maxTokens = Number(process.env.MAX_TOKENS ?? 1024);
const store = new MemoryStore();
store.set(SECRET_WORKER_KEY, bytesToHex(generateSecretKey()));
const worker = await startWorker({ config: cfg, store, provider: buildProvider(cfg, store), log: createLogger("info"), writeStatus: false });

const pool = new RelayPool([relayUrl]);
const client = new WorkerClient({ pool, identity: user, workerPubkey: worker.pubkey, chatTimeoutMs: 600_000 });
client.start();
while (pool.connectedCount === 0 || worker.pool.connectedCount === 0) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 300));

let t = Date.now();
console.log("server.info:", JSON.stringify(await client.serverInfo()).slice(0, 200), `${Date.now() - t}ms`);
t = Date.now();
console.log("models:", (await client.listModels()).map((m) => `${m.id} ctx=${m.contextLength}`), `${Date.now() - t}ms`);

t = Date.now();
let first = 0;
let updates = 0;
let lastLen = 0;
const h = client.chat(
  { model, messages: [{ role: "user", content: prompt }] },
  {
    onAck: () => console.log(`ack after ${Date.now() - t}ms`),
    onUpdate: (s) => {
      updates++;
      if (!first) first = Date.now() - t;
      process.stdout.write(s.content.slice(lastLen));
      lastLen = s.content.length;
    },
  },
);
if (process.env.CANCEL_AFTER_MS) setTimeout(() => void h.cancel(), Number(process.env.CANCEL_AFTER_MS));
const r = await h.result;
console.log(`\n---\nfinish=${r.finishReason} first-update=${first}ms total=${Date.now() - t}ms updates=${updates} content=${r.content.length}ch reasoning=${r.reasoning.length}ch usage=${JSON.stringify(r.usage)} incomplete=${r.incomplete}`);
t = Date.now();
const metrics = await client.metrics({ model, host: true });
console.log(`metrics (${Date.now() - t}ms):`, JSON.stringify({ model: metrics.model, host: metrics.host, monitoring: metrics.monitoring }, null, 1));
client.stop();
pool.close();
await worker.stop();
process.exit(0);
