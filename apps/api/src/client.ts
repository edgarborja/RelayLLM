import { randomUUID } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { generateSecretKey } from "nostr-tools/pure";
import { LocalSigner, RelayPool, RemoteError, WorkerClient, type ChatResult } from "@relayllm/nostr-transport";
import { schemaProblem, type ChatMessage, type ChatParams, type Limits } from "@relayllm/protocol";
import { RelayLLMError } from "./errors.ts";
import { checkTarget, decodeSecretKey, loadProfile } from "./profile.ts";
import type { ConnectOptions, Model, RelayLLM, RunRequest, RunResult, Usage } from "./types.ts";

/** Failures worth repeating: the request never ran to completion. */
const TRANSIENT = new Set(["no_response", "publish_failed", "not_found", "provider_unavailable", "incomplete"]);
/** The worker asked us to wait. */
const WAIT = new Set(["busy", "rate_limited"]);
const TRANSIENT_ATTEMPTS = 3;
const INVALID_OUTPUT_ATTEMPTS = 2;

export interface Link {
  client: WorkerClient;
  pool: RelayPool;
  close(): void;
}

/** Open relay connections and wait until one is usable. */
export async function openLink(target: { workerPubkey: string; relays: string[]; secretKey: Uint8Array }, requestTimeoutMs = 15_000): Promise<Link> {
  // A throwaway key receives replies and answers relay AUTH, as in the web client.
  const session = new LocalSigner(generateSecretKey());
  const pool = new RelayPool(target.relays, { authSigner: (t) => session.signEvent(t) });
  const client = new WorkerClient({ pool, identity: new LocalSigner(target.secretKey), workerPubkey: target.workerPubkey, session, requestTimeoutMs });
  const close = () => {
    client.stop();
    pool.close();
  };
  let online = false;
  let opened!: () => void;
  const open = new Promise<void>((r) => (opened = r));
  pool.opts.onStatus = () => {
    const now = pool.connectedCount > 0;
    if (now === online) return;
    online = now;
    client.onConnectivity(now);
    if (now) opened();
  };
  client.start();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    open.then(() => false),
    new Promise<true>((r) => (timer = setTimeout(() => r(true), requestTimeoutMs))),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    close();
    throw new RelayLLMError("publish_failed", "Could not connect to any relay.");
  }
  await sleep(150); // let subscriptions settle
  return { client, pool, close };
}

/** Wait, returning early if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function connect(options: ConnectOptions = {}): Promise<RelayLLM> {
  let { worker, relays, secretKey } = options;
  const direct = [worker, relays, secretKey].filter((x) => x !== undefined).length;
  if (direct !== 0 && direct !== 3) throw new RelayLLMError("no_profile", "Give worker, relays and secretKey together, or use a profile.");
  if (!direct) {
    const name = options.profile ?? "default";
    const p = loadProfile(name);
    if (!p) throw new RelayLLMError("no_profile", `No "${name}" profile. Create it with: relayllm-api pair '<pairing link>'`);
    ({ worker, relays, secretKey } = p);
  }
  const link = await openLink({ ...checkTarget(worker!, relays!), secretKey: decodeSecretKey(secretKey!) }, options.requestTimeoutMs);
  try {
    const info = await retryRead(() => link.client.serverInfo());
    const models = await retryRead(() => link.client.listModels());
    return new Connection(
      link,
      info.name,
      info.limits,
      models.map((m) => ({ id: m.id, contextLength: m.contextLength, reasoningOptions: m.reasoningOptions ?? [] })),
      options.maxWaitMs ?? 600_000,
    );
  } catch (e) {
    link.close();
    throw e instanceof RemoteError ? new RelayLLMError(e.code, e.message) : e;
  }
}

/** Ephemeral events can be lost and limits hit; requests that only read are repeated. */
async function retryRead<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof RemoteError) || attempt >= TRANSIENT_ATTEMPTS) throw e;
      if (e.code === "rate_limited") await sleep(Math.min(60, e.retryAfter ?? 5) * 1000);
      else if (!TRANSIENT.has(e.code)) throw e;
    }
  }
}

type Attempt =
  | { kind: "ok"; output: unknown; usage?: Usage }
  | { kind: "fail"; code: string; message: string; retryAfter?: number; text?: string; usage?: Usage };

class Connection implements RelayLLM {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #closed = new AbortController();
  readonly #validators = new WeakMap<object, ValidateFunction>();

  constructor(
    private readonly link: Link,
    readonly workerName: string,
    private readonly limits: Limits,
    readonly models: Model[],
    private readonly maxWaitMs: number,
  ) {}

  get structuredOutput(): boolean {
    return this.limits.maxSchemaChars !== undefined;
  }

  close(): void {
    this.#closed.abort();
    this.link.close();
  }

  async run<T = unknown>(req: RunRequest): Promise<RunResult<T>> {
    const model = this.#model(req.model);
    const validate = req.schema ? this.#validator(req.schema) : undefined;
    if (typeof req.input !== "string" || !req.input.trim()) throw new RelayLLMError("invalid_request", "The input is empty.");
    // The worker runs one request per user at a time, so queue here instead of being refused.
    const job = this.#queue.then(() => this.#run(req, model, validate));
    this.#queue = job.catch(() => undefined);
    return job as Promise<RunResult<T>>;
  }

  #model(id?: string): string {
    if (id) {
      if (!this.models.some((m) => m.id === id)) throw new RelayLLMError("model_unavailable", `The worker doesn't offer "${id}". Available: ${this.models.map((m) => m.id).join(", ") || "none"}.`);
      return id;
    }
    if (this.models.length === 1) return this.models[0]!.id;
    throw new RelayLLMError("model_unavailable", this.models.length ? `Choose a model: ${this.models.map((m) => m.id).join(", ")}.` : "The worker offers no models.");
  }

  #validator(schema: Record<string, unknown>): ValidateFunction {
    const known = this.#validators.get(schema);
    if (known) return known;
    if (this.limits.maxSchemaChars === undefined) throw new RelayLLMError("unsupported", "This worker doesn't support structured output. Update and restart it.");
    const problem = schemaProblem(schema, this.limits.maxSchemaChars);
    if (problem) throw new RelayLLMError("invalid_schema", problem);
    try {
      // Fresh instance: two schemas may share an $id. The dialect marker is ignored.
      const { $schema: _, ...body } = schema;
      const v = new Ajv2020({ strict: false, allErrors: true, validateFormats: false, logger: false }).compile(body);
      this.#validators.set(schema, v);
      return v;
    } catch (e) {
      throw new RelayLLMError("invalid_schema", `The schema is not valid: ${(e as Error).message}`);
    }
  }

  async #run(req: RunRequest, model: string, validate?: ValidateFunction): Promise<RunResult> {
    const id = req.id ?? randomUUID();
    const startedAt = performance.now();
    const signal = req.signal ? AbortSignal.any([req.signal, this.#closed.signal]) : this.#closed.signal;
    let attempts = 0;
    let transient = 0;
    let invalid = 0;
    let waited = 0;
    for (;;) {
      let r: Attempt;
      if (signal.aborted) r = { kind: "fail", code: "cancelled", message: "Cancelled." };
      else {
        attempts++;
        r = await this.#attempt(req, model, validate, signal);
      }
      const ms = Math.round(performance.now() - startedAt);
      if (r.kind === "ok") return { id, ok: true, model, output: r.output, finish: "stop", usage: r.usage, attempts, ms };

      let delay: number | null = null;
      if (!signal.aborted) {
        if (WAIT.has(r.code)) {
          delay = Math.max(1, r.retryAfter ?? 5) * 1000;
          waited += delay;
          if (waited > this.maxWaitMs) delay = null;
        } else if (TRANSIENT.has(r.code) && ++transient < TRANSIENT_ATTEMPTS) delay = 1000 * 2 ** transient;
        else if (r.code === "invalid_output" && ++invalid < INVALID_OUTPUT_ATTEMPTS) delay = 0;
      }
      if (delay === null) return { id, ok: false, model, error: { code: r.code, message: r.message }, text: r.text || undefined, usage: r.usage, attempts, ms };
      await sleep(delay, signal);
    }
  }

  async #attempt(req: RunRequest, model: string, validate: ValidateFunction | undefined, signal: AbortSignal): Promise<Attempt> {
    const messages: ChatMessage[] = [];
    if (req.system?.trim()) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.input });
    const params: ChatParams = {
      temperature: req.temperature,
      top_p: req.topP,
      max_tokens: req.maxTokens,
      reasoning: req.reasoning,
      responseFormat: req.schema ? { type: "json_schema", schema: req.schema } : undefined,
    };
    let text = "";
    const handle = this.link.client.chat({ model, messages, params }, {
      onUpdate: (s) => {
        text = s.content;
        req.onText?.(s.content);
      },
    });
    let cancelled: Promise<unknown> | undefined;
    const onAbort = () => (cancelled = handle.cancel());
    signal.addEventListener("abort", onAbort, { once: true });
    let r: ChatResult;
    try {
      r = await handle.result;
      // Give the worker a chance to confirm that it stopped.
      await cancelled;
    } catch (e) {
      if (signal.aborted) return { kind: "fail", code: "cancelled", message: "Cancelled.", text };
      if (e instanceof RemoteError) return { kind: "fail", code: e.code, message: e.message, retryAfter: e.retryAfter, text };
      return { kind: "fail", code: "internal", message: (e as Error).message, text };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    const u = r.usage;
    const usage: Usage | undefined = u && { promptTokens: u.promptTokens, completionTokens: u.completionTokens, reasoningTokens: u.reasoningTokens, tokensPerSecond: u.tokensPerSecond };
    const fail = (code: string, message: string): Attempt => ({ kind: "fail", code, message, text: r.content, usage });
    if (r.finishReason === "cancelled") return fail("cancelled", "Cancelled.");
    if (r.finishReason === "length") {
      const why = u?.detail === "context_full" ? "the model's context window is full" : u?.detail === "response_size" ? "the answer exceeded the worker's size limit" : "the generation budget ran out";
      return fail("truncated", `The answer was cut off: ${why}.`);
    }
    if (r.finishReason !== "stop") return fail(r.errorCode ?? r.finishReason, r.finishReason === "timeout" ? "The worker stopped the request: time limit reached." : "The model failed to answer.");
    if (r.incomplete) return fail("incomplete", "Part of the answer was lost in transit.");
    if (!r.content.trim()) return fail("invalid_output", "The model returned an empty answer.");
    if (!validate) return { kind: "ok", output: r.content, usage };
    let output: unknown;
    try {
      // Engines that ignore the schema often wrap JSON in a code fence.
      output = JSON.parse(r.content.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1"));
    } catch {
      return fail("invalid_output", "The model's answer is not valid JSON.");
    }
    if (!validate(output)) {
      const why = (validate.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || "output"} ${e.message}`).join("; ");
      return fail("invalid_output", `The answer doesn't match the schema: ${why}`);
    }
    return { kind: "ok", output, usage };
  }
}
