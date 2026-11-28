import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { REASONING_MODES, SYSTEM_PROMPT_STYLES } from "@relayllm/provider-adapters";

import { DEFAULT_RELAYS as SHARED_RELAYS } from "@relayllm/nostr-transport";

export const DEFAULT_RELAYS = [...SHARED_RELAYS];
/** No default: pairing links must point at a client deployment you control. */
export const DEFAULT_CLIENT_URL = "";

export const DEFAULT_REQUEST_TIMEOUT_SEC = 1800;
export const DEFAULT_MAX_TOKENS = 16_384;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const ConfigSchema = z.object({
  version: z.literal(1),
  name: z.string().max(64).default("RelayLLM Worker"),
  keyStorage: z.enum(["keychain", "file"]),
  provider: z.object({
    kind: z.enum(["lmstudio", "ollama", "vllm", "openai-compatible"]),
    baseUrl: z.string(),
    allowRemoteEndpoint: z.boolean().default(false),
    streaming: z.boolean().default(true),
    /** Whether an API key is stored in the secret store. */
    hasApiKey: z.boolean().default(false),
    /** How system instructions reach the engine (see provider-adapters/system-prompt.ts). */
    systemPromptStyle: z.enum(SYSTEM_PROMPT_STYLES).default("system"),
  }),
  models: z.object({
    /** Models remote clients may use. Nothing is exposed unless listed. */
    exposed: z.array(z.string().min(1).max(256)).default([]),
    /** Models that exist even though discovery doesn't report them. */
    manual: z.array(z.string().min(1).max(256)).default([]),
    /** Per-model override of provider.systemPromptStyle. */
    systemPromptStyle: z.record(z.string().min(1).max(256), z.enum(SYSTEM_PROMPT_STYLES)).default({}),
    /** Reasoning control for engines that don't advertise one (vLLM, generic). */
    reasoning: z.record(z.string().min(1).max(256), z.enum(REASONING_MODES)).default({}),
  }),
  relays: z.array(z.string()).min(1),
  clientUrl: z.string().refine((u) => u === "" || /^https?:\/\//.test(u), "must be an http(s) URL").default(DEFAULT_CLIENT_URL),
  access: z.object({
    mode: z.enum(["private", "public"]).default("private"),
    users: z
      .array(z.object({ pubkey: hex64, label: z.string().max(64).optional(), addedAt: z.number() }))
      .default([]),
    pending: z
      .array(z.object({ pubkey: hex64, label: z.string().max(64).optional(), requestedAt: z.number() }))
      .default([]),
    invites: z
      .array(z.object({ hash: z.string(), expiresAt: z.number(), label: z.string().max(64).optional() }))
      .default([]),
  }),
  limits: z
    .object({
      maxConcurrent: z.number().int().min(1).default(2),
      perUserConcurrent: z.number().int().min(1).default(1),
      requestsPerMinute: z.number().int().min(1).default(20),
      publicRequestsPerMinute: z.number().int().min(1).default(4),
      publicRequestsPerDay: z.number().int().min(1).default(100),
      /** Absolute limit for one request, whatever the engine is doing. */
      requestTimeoutSec: z.number().int().min(5).default(DEFAULT_REQUEST_TIMEOUT_SEC),
      /** Abort when text was streaming and then nothing arrives for this long. */
      inactivityTimeoutSec: z.number().int().min(5).default(120),
      /** Status heartbeat to the client while a request is active. */
      heartbeatSec: z.number().int().min(2).max(60).default(10),
      maxRequestBytes: z.number().int().min(1000).default(400_000),
      maxMessages: z.number().int().min(1).default(200),
      maxResponseChars: z.number().int().min(100).default(200_000),
      /** Generation budget (reasoning + answer): cap for max_tokens, and its default. */
      maxTokens: z.number().int().min(1).default(DEFAULT_MAX_TOKENS),
      /** Total size of the client's system instructions. */
      maxSystemPromptChars: z.number().int().min(0).default(32_000),
      /** Largest JSON schema a client may request output in (0 disables structured output). */
      maxSchemaChars: z.number().int().min(0).default(16_000),
    })
    .prefault({}),
  monitoring: z
    .object({
      /** Share machine memory stats with authorized users. Off unless the owner enables it. */
      host: z.boolean().default(false),
      /** How often clients refresh while their metrics panel is open. */
      intervalSec: z.number().int().min(2).max(300).default(10),
      /** vLLM: read the local Prometheus endpoint for KV-cache and queue stats. */
      engineMetrics: z.boolean().default(false),
    })
    .prefault({}),
  streaming: z
    .object({
      batchMs: z.number().int().min(50).max(5000).default(250),
      maxBatchChars: z.number().int().min(100).max(16_000).default(4000),
      resumeBufferSec: z.number().int().min(10).default(180),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function relayllmHome(): string {
  return process.env.RELAYLLM_HOME || join(homedir(), ".relayllm");
}

export const configPath = (home = relayllmHome()) => join(home, "config.json");
export const statusPath = (home = relayllmHome()) => join(home, "status.json");

export function ensureHome(home = relayllmHome()): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
}

export function defaultConfig(partial: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    keyStorage: process.platform === "darwin" ? "keychain" : "file",
    provider: { kind: "lmstudio", baseUrl: "http://localhost:1234/v1" },
    models: {},
    relays: DEFAULT_RELAYS,
    access: {},
    ...partial,
  });
}

export function configExists(home = relayllmHome()): boolean {
  return existsSync(configPath(home));
}

export function loadConfig(home = relayllmHome()): Config {
  const p = configPath(home);
  if (!existsSync(p)) throw new Error(`No configuration at ${p}. Run "relayllm init" first.`);
  const raw = JSON.parse(readFileSync(p, "utf8"));
  migrate(raw);
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) {
    throw new Error(`Invalid configuration in ${p}: ${res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return res.data;
}

/**
 * Configs saved before reasoning support spell out the old defaults (300 s,
 * 8192 tokens), which cut off reasoning models. Raise those exact values once;
 * anything the owner changed is kept.
 */
function migrate(raw: { limits?: Record<string, unknown> }): void {
  const l = raw?.limits;
  if (!l || typeof l !== "object" || "inactivityTimeoutSec" in l) return;
  if (l.requestTimeoutSec === 300) l.requestTimeoutSec = DEFAULT_REQUEST_TIMEOUT_SEC;
  if (l.maxTokens === 8192) l.maxTokens = DEFAULT_MAX_TOKENS;
}

/** Atomic write with owner-only permissions. */
export function saveConfig(cfg: Config, home = relayllmHome()): void {
  ensureHome(home);
  const p = configPath(home);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ConfigSchema.parse(cfg), null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
}

/** Read-modify-write against the latest file contents. */
export function updateConfig(mutate: (cfg: Config) => void, home = relayllmHome()): Config {
  const cfg = loadConfig(home);
  mutate(cfg);
  saveConfig(cfg, home);
  return cfg;
}

export function configMtime(home = relayllmHome()): number {
  try {
    return statSync(configPath(home)).mtimeMs;
  } catch {
    return 0;
  }
}
