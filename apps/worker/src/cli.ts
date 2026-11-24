import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { generateSecretKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { bytesToHex } from "@noble/hashes/utils.js";
import qrcode from "qrcode-terminal";
import { buildPairingUrl, hexToNpub, normalizeRelayUrl, npubToHex } from "@relayllm/nostr-transport";
import {
  checkProviderEndpoint,
  createProvider,
  PROVIDER_DEFAULTS,
  REASONING_MODES,
  SYSTEM_PROMPT_STYLES,
  type ProviderKind,
  type ProviderModel,
  type ReasoningMode,
  type SystemPromptStyle,
} from "@relayllm/provider-adapters";
import { addUser, createInvite, removeUser } from "./access.ts";
import {
  configExists,
  configPath,
  defaultConfig,
  DEFAULT_CLIENT_URL,
  DEFAULT_RELAYS,
  ensureHome,
  loadConfig,
  relayllmHome,
  saveConfig,
  statusPath,
  updateConfig,
  type Config,
} from "./config.ts";
import { createLogger } from "./log.ts";
import { KeychainStore, openSecretStore, SECRET_PROVIDER_KEY, SECRET_WORKER_KEY, type SecretStore } from "./secrets.ts";
import { buildProvider, loadOrCreateIdentity, startWorker, type WorkerStatus } from "./worker.ts";

const VERSION = "0.1.0";
/** Default lifetime of single-use invites. */
const DEFAULT_INVITE_TTL = "7d";
const home = relayllmHome();

const HELP = `RelayLLM Worker ${VERSION} — use your local LLM from anywhere over encrypted Nostr messages.

Setup
  relayllm init                       Guided setup (provider, models, identity, relays, access)
  relayllm init --yes [--provider lmstudio --url URL --models all|id,id --relays a,b
                --client-url URL --name NAME --key-storage keychain|file --owner NPUB]
                                      Non-interactive setup
  relayllm start                      Run the worker (Ctrl+C to stop)
  relayllm status                     Show worker, relay and provider status
  relayllm pair [--invite] [--ttl 7d] [--label NAME]
                                      Show npub, pairing link and QR code
                                      (--invite adds a single-use access token)

Models
  relayllm models                     List discovered models and which are exposed
  relayllm models enable <id>...      Expose models to authorized users
  relayllm models disable <id>...     Stop exposing models
  relayllm models add <id>            Add a model that discovery does not report
  relayllm models system-style <id> system|developer|user-prefix|default
                                      How system prompts reach this model
  relayllm models reasoning <id> toggle|effort|default
                                      Reasoning control for engines that don't advertise one

Users
  relayllm users                      List authorized users and pending requests
  relayllm users add <npub> [--label NAME]
  relayllm users approve <npub>       Approve a pending access request
  relayllm users remove <npub>
  relayllm access private|public      Set access mode (private is the default)

Configuration
  relayllm relays [add|remove <url>]  List or change Nostr relays
  relayllm provider                   Show provider configuration
  relayllm provider set [--kind K] [--url URL] [--api-key] [--no-api-key] [--allow-remote]
                       [--system-style system|developer|user-prefix]
  relayllm client-url <url>           Set the web client URL used in pairing links
  relayllm limits [--max-tokens N] [--absolute SEC] [--inactivity SEC] [--heartbeat SEC]
                                      Generation budget and timeouts
  relayllm monitoring [on|off] [--interval SEC] [--engine-metrics on|off]
                                      Share machine memory stats with authorized users
                                      (off by default); vLLM Prometheus stats
  relayllm identity                   Show the worker npub
  relayllm identity rotate            Generate a new worker identity (re-pair all devices)
  relayllm identity import            Import an existing nsec (read from hidden prompt)
  relayllm service [launchd|systemd]  Print a service definition to run at login/boot

Config directory: ${home}  (override with RELAYLLM_HOME)
`;

function out(s = ""): void {
  process.stdout.write(s + "\n");
}
function fail(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

function store(cfg: Config): SecretStore {
  return openSecretStore(cfg.keyStorage, home);
}

function identityOrFail(cfg: Config) {
  const id = loadOrCreateIdentity(store(cfg), false);
  if (!id) fail('no worker identity. Run "relayllm init".');
  return id;
}

function showQr(text: string): Promise<void> {
  return new Promise((r) =>
    qrcode.generate(text, { small: true }, (q: string) => {
      out(q);
      r();
    }),
  );
}

/** Print the pairing link (if a client URL is configured) plus manual details. */
async function printPairing(cfg: Config, pubkey: string, invite?: string, inviteNote = ""): Promise<void> {
  out(`Worker npub: ${hexToNpub(pubkey)}`);
  out(`Relays:      ${cfg.relays.join(", ")}`);
  if (!cfg.clientUrl) {
    out("\nNo web client URL configured, so no pairing link can be generated.");
    out('Set it with: relayllm client-url https://<you>.github.io/<repo>/   (see docs/deploy-github-pages.md)');
    out("Meanwhile, add the worker in the client manually using the npub and relays above.");
    if (invite) out(`One-time invite code (enter it in the client's "Add worker" dialog): ${invite}`);
    return;
  }
  const url = buildPairingUrl(cfg.clientUrl, { workerPubkey: pubkey, relays: cfg.relays, name: cfg.name, invite });
  out(`\nPairing link${inviteNote}:\n${url}\n`);
  await showQr(url);
}

function parseDuration(s: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(s.trim());
  if (!m) fail(`invalid duration "${s}" (use e.g. 30m, 24h, 7d)`);
  const n = Number(m[1]);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400, "": 3600 } as Record<string, number>)[m[2]!]!;
}

async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line.trim();
    }
    return "";
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = "";
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

function parseNsec(input: string): Uint8Array {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/.test(s)) return Uint8Array.from(Buffer.from(s, "hex"));
  const d = nip19.decode(s);
  if (d.type !== "nsec") throw new Error("not an nsec");
  return d.data;
}

function userLabel(cfg: Config, pubkey: string): string {
  const u = cfg.access.users.find((x) => x.pubkey === pubkey) ?? cfg.access.pending.find((x) => x.pubkey === pubkey);
  return u?.label ? ` (${u.label})` : "";
}

// ------------------------------------------------------------------ init

async function cmdInit(args: string[]): Promise<void> {
  const { values: flags } = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y" },
      provider: { type: "string" },
      url: { type: "string" },
      models: { type: "string" },
      relays: { type: "string" },
      "client-url": { type: "string" },
      name: { type: "string" },
      "key-storage": { type: "string" },
      owner: { type: "string" },
    },
  });
  ensureHome(home);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // With --yes, every prompt takes its flag value or default (scriptable setup).
  const answers: Record<string, string | undefined> = {
    "Choose your engine": flags.provider ? String(Object.keys(PROVIDER_DEFAULTS).indexOf(flags.provider) + 1) : undefined,
    "API base URL (include /v1)": flags.url,
    "Which models should remote users be able to use? (numbers, comma-separated, or 'all')": flags.models,
    "Enter model ids to expose (comma-separated), or leave empty": flags.models,
    "Relays (comma-separated)": flags.relays,
    "Web client URL where you host RelayLLM (leave empty if not deployed yet)": flags["client-url"],
    "Display name for this worker": flags.name,
    "Your own npub, if you already have one (optional)": flags.owner,
    "Store keys in the macOS Keychain (recommended) or a protected file? (keychain/file)": flags["key-storage"],
  };
  const ask = async (q: string, def?: string) => {
    if (flags.yes) {
      const v = answers[q] ?? def ?? "";
      out(`${q}: ${v}`);
      return v;
    }
    const a = (await rl.question(def !== undefined ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def || "";
  };
  const existing = configExists(home) ? loadConfig(home) : null;
  if (existing) {
    const a = await ask("A configuration already exists. Reconfigure it? (y/N)", flags.yes ? "y" : "n");
    if (!/^y/i.test(a)) {
      rl.close();
      out("Nothing changed.");
      return;
    }
  }
  const cfg = existing ?? defaultConfig();

  out("\nStep 1/7 — AI engine");
  const kinds = Object.keys(PROVIDER_DEFAULTS) as ProviderKind[];
  kinds.forEach((k, i) => out(`  ${i + 1}) ${PROVIDER_DEFAULTS[k].label}`));
  const kindIdx = Number(await ask("Choose your engine", String(kinds.indexOf(cfg.provider.kind) + 1))) - 1;
  const kind = kinds[kindIdx] ?? "lmstudio";

  out("\nStep 2/7 — Finding the engine's local API");
  const candidates = [...new Set([cfg.provider.kind === kind ? cfg.provider.baseUrl : "", ...PROVIDER_DEFAULTS[kind].baseUrls].filter(Boolean))];
  let found = "";
  for (const url of candidates) {
    const p = createProvider(kind, { baseUrl: url, metaTimeoutMs: 1500 });
    const h = await p.health();
    out(`  ${h.ok ? "✓" : "✗"} ${url}${h.ok ? "" : ` (${h.detail})`}`);
    if (h.ok && !found) found = url;
  }
  let baseUrl = await ask("API base URL (include /v1)", found || candidates[0] || "http://localhost:1234/v1");
  let allowRemote = false;
  let check = checkProviderEndpoint(baseUrl);
  if (!check.ok) {
    out(`  ${check.reason}`);
    const a = await ask("This endpoint is not on this machine. Allow it anyway? (y/N)", "n");
    if (!/^y/i.test(a)) fail("aborted: choose a loopback endpoint or confirm remote access");
    allowRemote = true;
    check = checkProviderEndpoint(baseUrl, { allowRemote });
    if (!check.ok) fail(check.reason!);
  }
  baseUrl = check.url!.toString();
  const needKey = /^y/i.test(await ask("Does the engine require an API key? (y/N)", cfg.provider.hasApiKey ? "y" : "n"));
  cfg.provider = { ...cfg.provider, kind, baseUrl, allowRemoteEndpoint: allowRemote, streaming: true, hasApiKey: needKey };

  out("\nStep 3/7 — Secret storage");
  const keychainOk = KeychainStore.available();
  if (keychainOk) {
    const a = await ask("Store keys in the macOS Keychain (recommended) or a protected file? (keychain/file)", cfg.keyStorage);
    cfg.keyStorage = a === "file" ? "file" : "keychain";
  } else {
    cfg.keyStorage = "file";
    out(`  Keys will be stored in ${join(home, "secrets")} (owner-only permissions).`);
  }
  rl.pause();
  const secrets = store(cfg);
  if (needKey) {
    const k = await askSecret("  API key (input hidden, leave empty to keep existing): ");
    if (k) secrets.set(SECRET_PROVIDER_KEY, k);
  }
  rl.resume();

  out("\nStep 4/7 — Models");
  let models: ProviderModel[] = [];
  try {
    models = await buildProvider(cfg, secrets).listModels();
  } catch (e) {
    out(`  Could not list models (${(e as Error).message}). You can add them later with "relayllm models add <id>".`);
  }
  const chatModels = models.filter((m) => m.chat);
  chatModels.forEach((m, i) => out(`  ${i + 1}) ${m.id}${m.type ? `  [${m.type}]` : ""}${m.contextLength ? `  ctx ${m.contextLength}` : ""}`));
  const hidden = models.filter((m) => !m.chat);
  if (hidden.length) out(`  (not chat-capable, hidden: ${hidden.map((m) => m.id).join(", ")})`);
  if (chatModels.length) {
    const defSel = cfg.models.exposed.length
      ? chatModels.map((m, i) => (cfg.models.exposed.includes(m.id) ? i + 1 : 0)).filter(Boolean).join(",")
      : "all";
    const sel = await ask("Which models should remote users be able to use? (numbers, comma-separated, or 'all')", defSel || "all");
    cfg.models.exposed =
      sel === "all"
        ? chatModels.map((m) => m.id)
        : sel
            .split(/[,\s]+/)
            .map((n) => chatModels[Number(n) - 1]?.id)
            .filter((x): x is string => !!x);
  } else {
    const manual = await ask("Enter model ids to expose (comma-separated), or leave empty", "");
    cfg.models.manual = manual.split(",").map((s) => s.trim()).filter(Boolean);
    cfg.models.exposed = [...cfg.models.manual];
  }

  out("\nStep 5/7 — Worker identity");
  const existingId = loadOrCreateIdentity(secrets, false);
  if (existingId) {
    out(`  Existing identity: ${hexToNpub(existingId.pubkey)} (kept)`);
  } else {
    const a = await ask("Generate a new identity, or import an nsec? (generate/import)", "generate");
    if (a === "import") {
      rl.pause();
      const nsec = await askSecret("  nsec (input hidden): ");
      rl.resume();
      try {
        secrets.set(SECRET_WORKER_KEY, bytesToHex(parseNsec(nsec)));
      } catch {
        fail("invalid nsec");
      }
    } else {
      loadOrCreateIdentity(secrets, true);
    }
  }
  const id = identityOrFail(cfg);

  out("\nStep 6/7 — Nostr relays");
  out("  Relays carry encrypted messages between your devices and this worker. Use 2–3.");
  const relayAns = await ask("Relays (comma-separated)", (cfg.relays.length ? cfg.relays : DEFAULT_RELAYS).join(","));
  const relays = relayAns.split(",").map((r) => normalizeRelayUrl(r)).filter((r): r is string => !!r);
  if (!relays.length) fail("at least one valid wss:// relay is required");
  cfg.relays = relays;
  const clientUrl = await ask("Web client URL where you host RelayLLM (leave empty if not deployed yet)", cfg.clientUrl || DEFAULT_CLIENT_URL);
  cfg.clientUrl = /^https?:\/\//.test(clientUrl) ? clientUrl : "";
  cfg.name = await ask("Display name for this worker", cfg.name);

  out("\nStep 7/7 — Access");
  out("  Private mode (default): only people you approve can use this worker.");
  cfg.access.mode = "private";
  const userNpub = await ask("Your own npub, if you already have one (optional)", "");
  if (userNpub) {
    const hex = npubToHex(userNpub);
    if (hex) addUser(cfg, hex, "owner");
    else out("  Not a valid npub; skipped. Use the pairing invite below instead.");
  }
  const token = createInvite(cfg, parseDuration(DEFAULT_INVITE_TTL), "first device");
  rl.close();
  saveConfig(cfg, home);

  out(`\nSaved ${configPath(home)}\n`);
  await printPairing(cfg, id.pubkey, token, ` — open it on the device you want to chat from (valid ${DEFAULT_INVITE_TTL.replace("d", " days")}, single use)`);
  out('Next: run "relayllm start" and keep it running.');
}

// ------------------------------------------------------------------ commands

async function cmdStart(): Promise<void> {
  const cfg = loadConfig(home);
  const log = createLogger();
  const w = await startWorker({ home, log });
  out(`RelayLLM worker ${VERSION} running as ${hexToNpub(w.pubkey)}`);
  out(`Provider: ${cfg.provider.kind} at ${cfg.provider.baseUrl}`);
  out(`Exposed models: ${cfg.models.exposed.join(", ") || "(none — run 'relayllm models enable <id>')"}`);
  out(`Access: ${cfg.access.mode}, ${cfg.access.users.length} authorized user(s)`);
  const stop = async () => {
    log.info("shutting down");
    await w.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

function cmdLimits(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { "max-tokens": { type: "string" }, absolute: { type: "string" }, inactivity: { type: "string" }, heartbeat: { type: "string" } },
  });
  const num = (name: keyof typeof values, min: number, max: number): number | undefined => {
    if (values[name] === undefined) return undefined;
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const maxTokens = num("max-tokens", 1, 1_000_000);
  const absolute = num("absolute", 5, 86_400);
  const inactivity = num("inactivity", 5, 86_400);
  const heartbeat = num("heartbeat", 2, 60);
  const changed = [maxTokens, absolute, inactivity, heartbeat].some((v) => v !== undefined);
  const { limits } = changed
    ? updateConfig((c) => {
        c.limits.maxTokens = maxTokens ?? c.limits.maxTokens;
        c.limits.requestTimeoutSec = absolute ?? c.limits.requestTimeoutSec;
        c.limits.inactivityTimeoutSec = inactivity ?? c.limits.inactivityTimeoutSec;
        c.limits.heartbeatSec = heartbeat ?? c.limits.heartbeatSec;
      }, home)
    : loadConfig(home);
  out(`Generation budget:   ${limits.maxTokens} tokens (reasoning + answer)`);
  out(`Absolute timeout:    ${limits.requestTimeoutSec}s`);
  out(`Inactivity timeout:  ${limits.inactivityTimeoutSec}s without new text, once text has started`);
  out(`Heartbeat:           every ${limits.heartbeatSec}s while a request is active`);
  if (changed) out("A running worker applies this to new requests within a few seconds.");
}

function cmdMonitoring(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { interval: { type: "string" }, "engine-metrics": { type: "string" } },
    allowPositionals: true,
  });
  const [mode] = positionals;
  if (mode && mode !== "on" && mode !== "off") fail("usage: relayllm monitoring [on|off] [--interval SEC] [--engine-metrics on|off]");
  const interval = values.interval === undefined ? undefined : Number(values.interval);
  if (interval !== undefined && (!Number.isInteger(interval) || interval < 2 || interval > 300)) fail("--interval must be 2–300 seconds");
  const engine = values["engine-metrics"];
  if (engine !== undefined && engine !== "on" && engine !== "off") fail("--engine-metrics must be on or off");
  const cfg =
    mode || interval !== undefined || engine !== undefined
      ? updateConfig((c) => {
          if (mode) c.monitoring.host = mode === "on";
          if (interval !== undefined) c.monitoring.intervalSec = interval;
          if (engine) c.monitoring.engineMetrics = engine === "on";
        }, home)
      : loadConfig(home);
  out(`Machine monitoring: ${cfg.monitoring.host ? "on" : "off"}${cfg.monitoring.host ? " (RAM, swap and memory pressure; shared with authorized users only)" : ""}`);
  out(`Refresh interval:   ${cfg.monitoring.intervalSec}s, only while a client has its metrics panel open`);
  out(`Engine metrics:     ${cfg.monitoring.engineMetrics ? "on" : "off"}${cfg.provider.kind === "vllm" ? "" : " (vLLM only)"}`);
  if (mode || interval !== undefined) out("A running worker picks this up within a few seconds.");
  if (engine) out("Restart the worker for the engine-metrics change to take effect.");
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig(home);
  const id = identityOrFail(cfg);
  out(`Worker:   ${cfg.name}`);
  out(`npub:     ${hexToNpub(id.pubkey)}`);
  out(`Access:   ${cfg.access.mode} — ${cfg.access.users.length} user(s), ${cfg.access.pending.length} pending`);
  out(`Models:   ${cfg.models.exposed.join(", ") || "(none exposed)"}`);
  out(`Monitor:  machine stats ${cfg.monitoring.host ? "shared with authorized users" : "off"}`);
  const p = buildProvider(cfg, store(cfg));
  const h = await p.health();
  out(`Provider: ${cfg.provider.kind} ${cfg.provider.baseUrl} — ${h.ok ? `reachable (${h.latencyMs}ms)` : `UNREACHABLE (${h.detail})`}`);
  const sp = statusPath(home);
  if (existsSync(sp)) {
    const st = JSON.parse(readFileSync(sp, "utf8")) as WorkerStatus;
    const age = (Date.now() - st.updatedAt) / 1000;
    let alive = age < 20;
    try {
      process.kill(st.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      out(`Process:  running (pid ${st.pid}, up ${Math.round((Date.now() - st.startedAt) / 60000)} min, ${st.activeRequests} active request(s))`);
      for (const r of st.relays) out(`  relay ${r.url}: ${r.state}${r.lastError ? ` (${r.lastError})` : ""}`);
    } else {
      out("Process:  not running");
    }
  } else {
    out("Process:  not running");
  }
}

async function cmdPair(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { invite: { type: "boolean" }, ttl: { type: "string" }, label: { type: "string" } },
  });
  let cfg = loadConfig(home);
  const id = identityOrFail(cfg);
  let token: string | undefined;
  if (values.invite) {
    const ttl = parseDuration(values.ttl ?? DEFAULT_INVITE_TTL);
    cfg = updateConfig((c) => {
      token = createInvite(c, ttl, values.label);
    }, home);
  }
  await printPairing(cfg, id.pubkey, token, token ? ` (single-use invite, expires in ${values.ttl ?? DEFAULT_INVITE_TTL})` : "");
  if (!token) out('Without an invite, new users appear as pending; approve them with "relayllm users approve <npub>".');
}

async function cmdModels(args: string[]): Promise<void> {
  const [sub, ...ids] = args;
  if (!sub || sub === "list") {
    const cfg = loadConfig(home);
    let models: ProviderModel[] = [];
    try {
      models = await buildProvider(cfg, store(cfg)).listModels();
    } catch (e) {
      out(`Discovery failed: ${(e as Error).message}`);
    }
    const all = new Map(models.map((m) => [m.id, m]));
    for (const id of cfg.models.manual) if (!all.has(id)) all.set(id, { id, chat: true });
    for (const id of cfg.models.exposed) if (!all.has(id)) all.set(id, { id, chat: true });
    if (!all.size) out("No models found.");
    for (const m of all.values()) {
      const on = cfg.models.exposed.includes(m.id);
      const style = cfg.models.systemPromptStyle[m.id];
      const flags = [m.type, m.contextLength ? `ctx ${m.contextLength}` : "", style ? `system prompt: ${style}` : "", !m.chat ? "not chat-capable" : "", !models.some((x) => x.id === m.id) ? "manual/not discovered" : ""]
        .filter(Boolean)
        .join(", ");
      out(`${on ? "[x]" : "[ ]"} ${m.id}${flags ? `  (${flags})` : ""}`);
    }
    out('\nEnable with "relayllm models enable <id>", disable with "relayllm models disable <id>".');
    return;
  }
  if (sub === "reasoning") {
    const [id, mode] = ids;
    const modes: readonly string[] = REASONING_MODES;
    if (!id || !mode || (mode !== "default" && !modes.includes(mode))) fail(`usage: relayllm models reasoning <id> ${REASONING_MODES.join("|")}|default`);
    updateConfig((c) => {
      if (mode === "default") delete c.models.reasoning[id];
      else c.models.reasoning[id] = mode as ReasoningMode;
    }, home);
    out(`Reasoning control for ${id}: ${mode === "default" ? "as advertised by the engine" : mode}. A running worker picks this up within a few seconds.`);
    return;
  }
  if (sub === "system-style") {
    const [id, style] = ids;
    const styles: readonly string[] = SYSTEM_PROMPT_STYLES;
    if (!id || !style || (style !== "default" && !styles.includes(style))) {
      fail(`usage: relayllm models system-style <id> ${SYSTEM_PROMPT_STYLES.join("|")}|default`);
    }
    updateConfig((c) => {
      if (style === "default") delete c.models.systemPromptStyle[id];
      else c.models.systemPromptStyle[id] = style as SystemPromptStyle;
    }, home);
    out(`System prompts for ${id}: ${style === "default" ? "provider default" : style}. A running worker picks this up within a few seconds.`);
    return;
  }
  if (!ids.length) fail(`usage: relayllm models ${sub} <id>...`);
  updateConfig((c) => {
    for (const id of ids) {
      if (sub === "enable") {
        if (!c.models.exposed.includes(id)) c.models.exposed.push(id);
      } else if (sub === "disable") {
        c.models.exposed = c.models.exposed.filter((x) => x !== id);
      } else if (sub === "add") {
        if (!c.models.manual.includes(id)) c.models.manual.push(id);
        if (!c.models.exposed.includes(id)) c.models.exposed.push(id);
      } else if (sub === "remove") {
        c.models.manual = c.models.manual.filter((x) => x !== id);
        c.models.exposed = c.models.exposed.filter((x) => x !== id);
      } else fail(`unknown subcommand "${sub}"`);
    }
  }, home);
  out("Updated. A running worker picks this up within a few seconds.");
}

async function cmdUsers(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, options: { label: { type: "string" } }, allowPositionals: true });
  const [sub, npub] = positionals;
  if (!sub || sub === "list") {
    const cfg = loadConfig(home);
    out(`Access mode: ${cfg.access.mode}`);
    out(`Authorized users (${cfg.access.users.length}):`);
    for (const u of cfg.access.users) out(`  ${hexToNpub(u.pubkey)}${u.label ? `  ${u.label}` : ""}`);
    if (cfg.access.pending.length) {
      out(`Pending requests (${cfg.access.pending.length}):`);
      for (const p of cfg.access.pending) out(`  ${hexToNpub(p.pubkey)}${p.label ? `  "${p.label}"` : ""}  ${new Date(p.requestedAt).toLocaleString()}`);
      out('Approve with "relayllm users approve <npub>".');
    }
    const live = cfg.access.invites.filter((i) => i.expiresAt > Date.now());
    if (live.length) out(`Unused invites: ${live.length}`);
    return;
  }
  if (!npub) fail(`usage: relayllm users ${sub} <npub>`);
  const hex = npubToHex(npub);
  if (!hex) fail("invalid npub");
  if (sub === "add" || sub === "approve") {
    const cfg = updateConfig((c) => addUser(c, hex, values.label ?? c.access.pending.find((p) => p.pubkey === hex)?.label), home);
    out(`Authorized ${npub}${userLabel(cfg, hex)}.`);
  } else if (sub === "remove" || sub === "deny") {
    let removed = false;
    updateConfig((c) => {
      removed = removeUser(c, hex);
    }, home);
    out(removed ? `Removed ${npub}.` : "That user was not in the list.");
  } else fail(`unknown subcommand "${sub}"`);
}

async function cmdAccess(args: string[]): Promise<void> {
  const mode = args[0];
  if (mode !== "private" && mode !== "public") {
    out(`Access mode: ${loadConfig(home).access.mode}`);
    out("usage: relayllm access private|public");
    return;
  }
  if (mode === "public") {
    out("WARNING: public mode lets ANY Nostr user run inference on this machine,");
    out("subject to rate limits (limits.publicRequestsPerMinute / publicRequestsPerDay).");
  }
  updateConfig((c) => (c.access.mode = mode), home);
  out(`Access mode set to ${mode}.`);
}

async function cmdRelays(args: string[]): Promise<void> {
  const [sub, url] = args;
  if (!sub || sub === "list") {
    for (const r of loadConfig(home).relays) out(r);
    return;
  }
  const norm = url ? normalizeRelayUrl(url) : null;
  if (!norm) fail("a valid relay URL (wss://...) is required");
  const cfg = updateConfig((c) => {
    if (sub === "add" && !c.relays.includes(norm)) c.relays.push(norm);
    else if (sub === "remove") c.relays = c.relays.filter((r) => r !== norm);
    else if (sub !== "add") fail(`unknown subcommand "${sub}"`);
    if (!c.relays.length) fail("at least one relay is required");
  }, home);
  out(`Relays: ${cfg.relays.join(", ")}`);
  out("Restart the worker to apply relay changes, and re-share the pairing link.");
}

async function cmdProvider(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "show") {
    const cfg = loadConfig(home);
    out(`kind:       ${cfg.provider.kind}`);
    out(`url:        ${cfg.provider.baseUrl}`);
    out(`api key:    ${cfg.provider.hasApiKey ? `stored in ${cfg.keyStorage}` : "none"}`);
    out(`streaming:  ${cfg.provider.streaming}`);
    out(`remote ok:  ${cfg.provider.allowRemoteEndpoint}`);
    out(`system:     ${cfg.provider.systemPromptStyle}`);
    return;
  }
  if (sub !== "set") fail(`unknown subcommand "${sub}"`);
  const { values } = parseArgs({
    args: rest,
    options: {
      kind: { type: "string" },
      url: { type: "string" },
      "api-key": { type: "boolean" },
      "no-api-key": { type: "boolean" },
      "allow-remote": { type: "boolean" },
      "no-streaming": { type: "boolean" },
      "system-style": { type: "string" },
    },
  });
  const cfg = loadConfig(home);
  if (values.kind) {
    if (!(values.kind in PROVIDER_DEFAULTS)) fail(`kind must be one of ${Object.keys(PROVIDER_DEFAULTS).join(", ")}`);
    cfg.provider.kind = values.kind as ProviderKind;
  }
  if (values["allow-remote"]) cfg.provider.allowRemoteEndpoint = true;
  if (values.url) {
    const c = checkProviderEndpoint(values.url, { allowRemote: cfg.provider.allowRemoteEndpoint });
    if (!c.ok) fail(c.reason!);
    cfg.provider.baseUrl = c.url!.toString();
  }
  if (values["no-streaming"]) cfg.provider.streaming = false;
  if (values["system-style"]) {
    const styles: readonly string[] = SYSTEM_PROMPT_STYLES;
    if (!styles.includes(values["system-style"])) fail(`--system-style must be one of ${SYSTEM_PROMPT_STYLES.join(", ")}`);
    cfg.provider.systemPromptStyle = values["system-style"] as SystemPromptStyle;
  }
  if (values["api-key"]) {
    const k = await askSecret("API key (input hidden): ");
    if (!k) fail("empty key");
    store(cfg).set(SECRET_PROVIDER_KEY, k);
    cfg.provider.hasApiKey = true;
  }
  if (values["no-api-key"]) {
    store(cfg).delete(SECRET_PROVIDER_KEY);
    cfg.provider.hasApiKey = false;
  }
  saveConfig(cfg, home);
  const h = await buildProvider(cfg, store(cfg)).health();
  out(`Saved. Provider ${h.ok ? "reachable" : `not reachable (${h.detail})`}. Restart the worker to apply.`);
}

async function cmdIdentity(args: string[]): Promise<void> {
  const cfg = loadConfig(home);
  const s = store(cfg);
  const sub = args[0];
  if (!sub || sub === "show") {
    const id = identityOrFail(cfg);
    out(`npub: ${hexToNpub(id.pubkey)}`);
    out(`hex:  ${id.pubkey}`);
    out(`Private key stored in: ${s.kind === "keychain" ? "macOS Keychain" : join(home, "secrets")}`);
    return;
  }
  if (sub === "rotate" || sub === "import") {
    out("This replaces the worker identity. Consequences:");
    out("  • Every paired device must add the worker again (new npub / pairing link).");
    out("  • Authorized users are kept; their devices just need the new link.");
    out("  • The old key is deleted and cannot be recovered unless you backed it up.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question("Type 'yes' to continue: ");
    rl.close();
    if (a.trim() !== "yes") fail("aborted");
    if (sub === "import") {
      const nsec = await askSecret("nsec (input hidden): ");
      try {
        s.set(SECRET_WORKER_KEY, bytesToHex(parseNsec(nsec)));
      } catch {
        fail("invalid nsec");
      }
    } else {
      s.set(SECRET_WORKER_KEY, bytesToHex(generateSecretKey()));
    }
    const id = identityOrFail(cfg);
    out(`New worker npub: ${hexToNpub(id.pubkey)}`);
    out('Restart the worker, then share the new link from "relayllm pair --invite".');
    return;
  }
  fail(`unknown subcommand "${sub}"`);
}

function cmdService(args: string[]): void {
  const kind = args[0] ?? (process.platform === "darwin" ? "launchd" : "systemd");
  // Prefer a stable launcher path (Homebrew's versioned Cellar path changes on upgrade).
  const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].find((p) => existsSync(p)) ?? process.execPath;
  const script = process.argv[1]!;
  if (kind === "launchd") {
    const label = "org.relayllm.worker";
    const logDir = join(homedir(), "Library", "Logs");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${script}</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>RELAYLLM_HOME</key><string>${home}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logDir}/relayllm.log</string>
  <key>StandardErrorPath</key><string>${logDir}/relayllm.log</string>
</dict>
</plist>
`;
    const dest = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    if (args[1] === "--install") {
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(dest, plist);
      out(`Wrote ${dest}\nLoad it with:\n  launchctl bootstrap gui/$(id -u) ${dest}\nStop with:\n  launchctl bootout gui/$(id -u)/${label}`);
    } else {
      out(plist);
      out(`# Save as ${dest} (or run "relayllm service launchd --install")`);
    }
    return;
  }
  if (kind === "systemd") {
    out(`# ~/.config/systemd/user/relayllm.service
[Unit]
Description=RelayLLM Worker
After=network-online.target

[Service]
ExecStart=${node} ${script} start
Environment=RELAYLLM_HOME=${home}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target

# Enable with:
#   systemctl --user daemon-reload && systemctl --user enable --now relayllm
#   loginctl enable-linger $USER   # keep running when logged out`);
    return;
  }
  fail("usage: relayllm service launchd|systemd [--install]");
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      return cmdInit(args);
    case "start":
      return cmdStart();
    case "status":
      return cmdStatus();
    case "pair":
    case "info":
      return cmdPair(args);
    case "models":
      return cmdModels(args);
    case "users":
      return cmdUsers(args);
    case "access":
      return cmdAccess(args);
    case "relays":
      return cmdRelays(args);
    case "provider":
      return cmdProvider(args);
    case "limits":
      return cmdLimits(args);
    case "monitoring":
      return cmdMonitoring(args);
    case "client-url": {
      const u = args[0];
      if (!u || !/^https?:\/\//.test(u)) fail("usage: relayllm client-url https://you.github.io/relayllm/");
      updateConfig((c) => (c.clientUrl = u), home);
      out(`Client URL set to ${u}`);
      return;
    }
    case "identity":
      return cmdIdentity(args);
    case "service":
      return cmdService(args);
    case "version":
    case "--version":
    case "-v":
      out(VERSION);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return;
    default:
      fail(`unknown command "${cmd}". Run "relayllm help".`);
  }
}

main().catch((e) => fail((e as Error).message));
