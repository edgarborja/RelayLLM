import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { hexToNpub, LocalSigner, parsePairingUrl, RemoteError } from "@relayllm/nostr-transport";
import { ReasoningSetting } from "@relayllm/protocol";
import { readItems, runBatch } from "./batch.ts";
import { connect, openLink } from "./client.ts";
import { RelayLLMError } from "./errors.ts";
import { checkTarget, decodeSecretKey, loadProfile, newSecretKey, profilePath, saveProfile, type Profile } from "./profile.ts";
import type { RunRequest } from "./types.ts";

const HELP = `relayllm-api: call a RelayLLM worker from scripts

  relayllm-api pair '<pairing link>' [--label NAME]
                                  Create this machine's API identity and request access.
                                  Get the link from the worker: relayllm pair --invite
  relayllm-api status             Show the worker, its models and this identity
  relayllm-api run [TEXT]         Run one request (TEXT or stdin); prints one JSON result
  relayllm-api batch FILE...      Run many, one by one; prints one JSON result per line
                                  .jsonl: one {"id", "input"} per line. Other files: one item each.

Options for run and batch:
  --system FILE|TEXT              System prompt (a file name, or the text itself)
  --schema FILE                   JSON Schema the output must match
  --model ID                      Needed if the worker offers several
  --reasoning off|on|low|...      Default: the model's own; always off with --schema
  --temperature N  --max-tokens N
  --out FILE                      batch: append results here; rerun to resume
  --profile NAME                  Default: "default"

Results go to stdout (or --out), progress to stderr. The exit code is 1 if anything failed.
`;

const err = (s: string) => process.stderr.write(`${s}\n`);
const out = (s: string) => process.stdout.write(s);
const usage = (message: string) => new RelayLLMError("invalid_request", message);

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        profile: { type: "string", default: "default" },
        label: { type: "string" },
        system: { type: "string" },
        schema: { type: "string" },
        model: { type: "string" },
        reasoning: { type: "string" },
        temperature: { type: "string" },
        "max-tokens": { type: "string" },
        out: { type: "string" },
      },
    });
  } catch (e) {
    err((e as Error).message);
    process.exit(2);
  }
})();

function number(name: "temperature" | "max-tokens", min: number, max: number, integer: boolean): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw usage(`--${name} must be a number from ${min} to ${max}.`);
  return n;
}

function settings(): Omit<RunRequest, "input"> {
  const s: Omit<RunRequest, "input"> = {
    model: values.model,
    temperature: number("temperature", 0, 2, false),
    maxTokens: number("max-tokens", 1, 1_000_000, true),
  };
  if (values.system !== undefined) {
    const isFile = existsSync(values.system);
    // A mistyped file name must not silently become the prompt.
    if (!isFile && /^\S+\.(md|txt)$/i.test(values.system)) throw usage(`${values.system} does not exist.`);
    s.system = isFile ? readFileSync(values.system, "utf8") : values.system;
  }
  if (values.schema !== undefined) {
    try {
      s.schema = JSON.parse(readFileSync(values.schema, "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw usage(`Could not read the schema: ${(e as Error).message}`);
    }
  }
  if (values.reasoning !== undefined && values.reasoning !== "auto") {
    const r = ReasoningSetting.safeParse(values.reasoning);
    if (!r.success) throw usage(`--reasoning must be one of: auto, ${ReasoningSetting.options.join(", ")}.`);
    s.reasoning = r.data;
  }
  return s;
}

function interruptible(): AbortSignal {
  const c = new AbortController();
  process.once("SIGINT", () => {
    err("Stopping… (Ctrl-C again to quit now)");
    c.abort();
    process.once("SIGINT", () => process.exit(130));
  });
  return c.signal;
}

async function pair(linkText: string | undefined): Promise<number> {
  if (!linkText) throw usage("Give the pairing link in quotes: relayllm-api pair '<link>'");
  const info = parsePairingUrl(linkText);
  if (!info) throw usage("That is not a pairing link.");
  const target = checkTarget(info.workerPubkey, info.relays);
  const worker = hexToNpub(target.workerPubkey);
  const old = loadProfile(values.profile);
  if (old && old.worker !== worker) throw usage(`Profile "${values.profile}" belongs to another worker. Use --profile NAME for this one.`);
  const profile: Profile = { version: 1, worker, relays: target.relays, name: info.name, secretKey: old?.secretKey ?? newSecretKey() };
  // Saved first: the invite is single-use, so the key must survive a lost reply.
  saveProfile(values.profile, profile);
  const secretKey = decodeSecretKey(profile.secretKey);
  const link = await openLink({ ...target, secretKey });
  try {
    const label = (values.label ?? `api@${hostname().split(".")[0]}`).slice(0, 64);
    const status = await link.client.pair(info.invite, label);
    const npub = hexToNpub(new LocalSigner(secretKey).pubkey);
    if (status === "approved") err(`Paired as ${npub}\nProfile: ${profilePath(values.profile)}`);
    else if (status === "pending") err(`Access requested. On the worker, run:\n  relayllm users approve ${npub}`);
    else err("The worker denied access.");
    return status === "approved" ? 0 : 1;
  } finally {
    link.close();
  }
}

async function main(): Promise<number> {
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) {
    out(HELP);
    return values.help ? 0 : 2;
  }
  if (cmd === "pair") return pair(args[0]);
  if (cmd !== "status" && cmd !== "run" && cmd !== "batch") throw usage(`Unknown command "${cmd}". See relayllm-api --help`);

  if (cmd === "status") {
    const llm = await connect({ profile: values.profile });
    const p = loadProfile(values.profile)!;
    const npub = hexToNpub(new LocalSigner(decodeSecretKey(p.secretKey)).pubkey);
    out(`${JSON.stringify({ worker: llm.workerName, workerNpub: p.worker, identity: npub, structuredOutput: llm.structuredOutput, models: llm.models }, null, 2)}\n`);
    llm.close();
    return 0;
  }

  const s = settings();
  if (cmd === "run") {
    if (args.length > 1) throw usage("Put the text in quotes.");
    if (!args.length && process.stdin.isTTY) throw usage("Give the text, or pipe it in.");
    const input = args[0] ?? readFileSync(0, "utf8");
    const llm = await connect({ profile: values.profile });
    try {
      const r = await llm.run({ ...s, input, signal: interruptible() });
      out(`${JSON.stringify(r, null, 2)}\n`);
      return r.ok ? 0 : 1;
    } finally {
      llm.close();
    }
  }

  if (!args.length) throw usage("Give the files to run.");
  const items = readItems(args);
  const llm = await connect({ profile: values.profile });
  try {
    if (!s.model && llm.models.length !== 1) throw usage(`Choose a --model: ${llm.models.map((m) => m.id).join(", ") || "none offered"}`);
    const total = await runBatch(llm, items, { ...s, model: s.model ?? llm.models[0]!.id }, {
      out: values.out,
      write: out,
      signal: interruptible(),
      onProgress: (n, r) => err(`[${n}/${items.length}] ${r.id}: ${r.ok ? `ok, ${(r.ms / 1000).toFixed(1)} s` : `${r.error.code}: ${r.error.message}`}`),
    });
    err(`${total.succeeded} done, ${total.failed} failed${total.skipped ? `, ${total.skipped} already done` : ""}${total.notRun ? `, ${total.notRun} not run` : ""}`);
    return total.failed ? 1 : 0;
  } finally {
    llm.close();
  }
}

main().then(
  // Exit explicitly once output is flushed: a relay socket may linger.
  (code) => process.stdout.write("", () => process.exit(code)),
  (e) => {
    err(e instanceof RelayLLMError || e instanceof RemoteError ? `${e.code}: ${e.message}` : `Error: ${(e as Error).message}`);
    process.exit(e instanceof RelayLLMError && e.code === "invalid_request" ? 2 : 1);
  },
);
