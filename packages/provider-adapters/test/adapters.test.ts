import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockProvider } from "@relayllm/test-utils";
import {
  checkProviderEndpoint,
  createProvider,
  LMStudioProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  ProviderError,
  applySystemPromptStyle,
  parsePrometheus,
  VLLMProvider,
  type ChatChunk,
} from "../src/index.ts";

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

/** fetch stub routing by path; records requested URLs. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const r = routes[url.pathname];
    if (!r) return new Response("not found", { status: 404 });
    return r(init);
  }) as typeof fetch;
  return { fn, calls };
}

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

describe("endpoint policy", () => {
  it("allows loopback, rejects remote/credentialed/non-http endpoints by default", () => {
    expect(checkProviderEndpoint("http://localhost:1234/v1").ok).toBe(true);
    expect(checkProviderEndpoint("http://127.0.0.1:11434/v1/").url?.toString()).toBe("http://127.0.0.1:11434/v1");
    expect(checkProviderEndpoint("http://[::1]:8000/v1").ok).toBe(true);
    expect(checkProviderEndpoint("http://192.168.1.10:8000/v1").ok).toBe(false);
    expect(checkProviderEndpoint("http://169.254.169.254/latest").ok).toBe(false);
    expect(checkProviderEndpoint("http://localhost.evil.com/v1").ok).toBe(false);
    expect(checkProviderEndpoint("file:///etc/passwd").ok).toBe(false);
    expect(checkProviderEndpoint("http://user:pw@localhost/v1").ok).toBe(false);
    expect(checkProviderEndpoint("http://gpu-box:8000/v1", { allowRemote: true }).ok).toBe(true);
    expect(() => new OpenAICompatibleProvider({ baseUrl: "http://10.0.0.5/v1" })).toThrow(/not loopback/);
  });
});

describe("LM Studio adapter (against mock server)", () => {
  let mock: MockProvider;
  beforeAll(async () => {
    mock = await MockProvider.start({ reasoning: "hmm", apiKey: "sk-local" });
  });
  afterAll(() => mock.close());

  it("discovers models with types and hides embeddings from chat", async () => {
    const p = new LMStudioProvider({ baseUrl: mock.baseUrl, apiKey: "sk-local" });
    const models = await p.listModels();
    expect(models.find((m) => m.id === "mock-embed")?.chat).toBe(false);
    expect(models.find((m) => m.id === "mock-llm-small")).toMatchObject({ chat: true, type: "llm", contextLength: 8192 });
    expect((await p.health()).ok).toBe(true);
  });

  it("sends the API key and streams reasoning + content", async () => {
    const p = new LMStudioProvider({ baseUrl: mock.baseUrl, apiKey: "sk-local" });
    const chunks = await collect(p.chat({ model: "mock-llm-small", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal));
    expect(chunks.filter((c) => c.type === "reasoning").map((c) => (c as { text: string }).text).join("")).toBe("hmm");
    expect(chunks.filter((c) => c.type === "content").map((c) => (c as { text: string }).text).join("")).toBe("Echo: hi");
    expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "stop", usage: { completionTokens: 3, reasoningTokens: 1 } });
  });

  it("reports auth failures as provider errors without leaking the body", async () => {
    const p = new LMStudioProvider({ baseUrl: mock.baseUrl, apiKey: "wrong" });
    const err = await collect(p.chat({ model: "x", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("HTTP 401");
  });

  it("works without streaming (non-streaming fallback)", async () => {
    const p = new LMStudioProvider({ baseUrl: mock.baseUrl, apiKey: "sk-local", streaming: false });
    expect(p.capabilities.streaming).toBe(false);
    const chunks = await collect(p.chat({ model: "m", messages: [{ role: "user", content: "yo" }] }, new AbortController().signal));
    expect(chunks).toEqual([
      { type: "content", text: "Echo: yo" },
      { type: "done", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 2 } },
    ]);
  });

  it("aborts mid-stream", async () => {
    const slow = await MockProvider.start({ tokenDelayMs: 20, reply: () => "a ".repeat(200) });
    const p = new LMStudioProvider({ baseUrl: slow.baseUrl });
    const ac = new AbortController();
    let n = 0;
    const err = await (async () => {
      for await (const _ of p.chat({ model: "m", messages: [{ role: "user", content: "x" }] }, ac.signal)) {
        if (++n === 5) ac.abort();
      }
    })().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("aborted");
    await expect.poll(() => slow.chats[0]?.aborted).toBe(true);
    await slow.close();
  });

  it("falls back to /v1/models when /api/v0 is unavailable", async () => {
    const { fn, calls } = fakeFetch({
      "/v1/models": () => Response.json({ data: [{ id: "foo" }, { id: "nomic-embed-text" }] }),
    });
    const p = new LMStudioProvider({ baseUrl: "http://localhost:1234/v1", fetchImpl: fn });
    expect(await p.listModels()).toEqual([
      { id: "foo", chat: true },
      { id: "nomic-embed-text", chat: false },
    ]);
    expect(calls).toEqual(["/api/v0/models", "/v1/models"]);
  });
});

describe("Ollama adapter (simulated Ollama API)", () => {
  it("discovers models via /api/tags and checks health via /api/version", async () => {
    const { fn, calls } = fakeFetch({
      "/api/version": () => Response.json({ version: "0.9.0" }),
      "/api/tags": () => Response.json({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b" }, { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest" }] }),
    });
    const p = new OllamaProvider({ baseUrl: "http://localhost:11434/v1", fetchImpl: fn });
    expect((await p.health()).ok).toBe(true);
    expect(await p.listModels()).toEqual([
      { id: "llama3.2:3b", chat: true },
      { id: "nomic-embed-text:latest", chat: false },
    ]);
    expect(calls).toEqual(["/api/version", "/api/tags"]);
  });

  it("streams via the OpenAI-compatible endpoint, including the `reasoning` field", async () => {
    let body: Record<string, unknown> = {};
    const { fn } = fakeFetch({
      "/v1/chat/completions": (init) => {
        body = JSON.parse(String(init?.body));
        return sse([
          { choices: [{ delta: { role: "assistant", reasoning: "thinking" } }] },
          { choices: [{ delta: { content: "Hel" } }] },
          { choices: [{ delta: { content: "lo" }, finish_reason: "length" }] },
          "[DONE]",
        ]);
      },
    });
    const p = createProvider("ollama", { baseUrl: "http://localhost:11434/v1", fetchImpl: fn });
    const chunks = await collect(p.chat({ model: "llama3.2:3b", messages: [{ role: "user", content: "hi" }], max_tokens: 10 }, new AbortController().signal));
    expect(chunks).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "content", text: "Hel" },
      { type: "content", text: "lo" },
      { type: "done", finishReason: "length", usage: undefined },
    ]);
    expect(body).toEqual({
      model: "llama3.2:3b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 10,
    });
  });
});

describe("vLLM / generic adapters", () => {
  it("use only the standard OpenAI paths", async () => {
    const { fn, calls } = fakeFetch({
      "/v1/models": () => Response.json({ data: [{ id: "Qwen/Qwen2.5-7B-Instruct" }] }),
      "/v1/chat/completions": () => sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]),
    });
    for (const kind of ["vllm", "openai-compatible"] as const) {
      const p = createProvider(kind, { baseUrl: "http://127.0.0.1:8000/v1", fetchImpl: fn });
      expect(p.kind).toBe(kind);
      expect((await p.listModels())[0]).toEqual({ id: "Qwen/Qwen2.5-7B-Instruct", chat: true });
      const chunks = await collect(p.chat({ model: "Qwen/Qwen2.5-7B-Instruct", messages: [{ role: "user", content: "x" }] }, new AbortController().signal));
      expect(chunks[0]).toEqual({ type: "content", text: "ok" });
    }
    expect(new Set(calls)).toEqual(new Set(["/v1/models", "/v1/chat/completions"]));
  });

  it("refuses redirects (no following the engine to other hosts)", async () => {
    const { fn } = fakeFetch({});
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return fn(input, init);
    }) as typeof fetch;
    const p = createProvider("vllm", { baseUrl: "http://127.0.0.1:8000/v1", fetchImpl: spy });
    await p.health();
  });

  it("reports an unreachable engine as unavailable", async () => {
    const p = createProvider("vllm", { baseUrl: "http://127.0.0.1:1/v1", metaTimeoutMs: 1000 });
    expect((await p.health()).ok).toBe(false);
    const err = await collect(p.chat({ model: "m", messages: [{ role: "user", content: "x" }] }, new AbortController().signal)).catch((e) => e);
    expect(err.code).toBe("unavailable");
  });
});

describe("system prompt conventions", () => {
  const msgs = [
    { role: "system" as const, content: "Rule A." },
    { role: "system" as const, content: "Rule B." },
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "hello" },
    { role: "user" as const, content: "bye" },
  ];

  it("merges leading system messages and rewrites them per style", () => {
    expect(applySystemPromptStyle(msgs, "system").slice(0, 2)).toEqual([
      { role: "system", content: "Rule A.\n\nRule B." },
      { role: "user", content: "hi" },
    ]);
    expect(applySystemPromptStyle(msgs, "developer")[0]).toEqual({ role: "developer", content: "Rule A.\n\nRule B." });
    expect(applySystemPromptStyle(msgs, "user-prefix")).toEqual([
      { role: "user", content: "Rule A.\n\nRule B.\n\nhi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);
    // No system prompt: untouched, whatever the style.
    expect(applySystemPromptStyle(msgs.slice(2), "user-prefix")).toEqual(msgs.slice(2));
    // Blank system prompt is dropped.
    expect(applySystemPromptStyle([{ role: "system", content: "  " }, ...msgs.slice(2)], "system")).toEqual(msgs.slice(2));
  });

  it("sends the configured convention, overridable per request by the worker", async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const { fn } = fakeFetch({
      "/v1/chat/completions": (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]);
      },
    });
    const p = createProvider("ollama", { baseUrl: "http://127.0.0.1:11434/v1", fetchImpl: fn, systemPromptStyle: "user-prefix" });
    await collect(p.chat({ model: "gemma", messages: msgs.slice(1, 3) }, new AbortController().signal));
    await collect(p.chat({ model: "llama", messages: msgs.slice(1, 3), systemPromptStyle: "system" }, new AbortController().signal));
    expect(bodies[0]!.messages).toEqual([{ role: "user", content: "Rule B.\n\nhi" }]);
    expect(bodies[1]!.messages).toEqual([
      { role: "system", content: "Rule B." },
      { role: "user", content: "hi" },
    ]);
  });
});

// ---------------------------------------------------------------- metrics

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const never = () => new Response("nope", { status: 404 });

describe("model metrics: LM Studio / Bionic", () => {
  // Shape captured from Bionic's /api/v1/models.
  const v1 = {
    models: [
      {
        type: "llm",
        key: "qwen/qwen3.5-9b",
        architecture: "qwen3_5",
        quantization: { name: "4bit", bits_per_weight: 4 },
        size_bytes: 5977257833,
        params_string: "9B",
        loaded_instances: [{ id: "qwen/qwen3.5-9b", engine: "mlx-llm", config: { context_length: 60928, parallel: 4 } }],
        max_context_length: 262144,
        variants: ["qwen/qwen3.5-9b@4bit"],
      },
      { type: "llm", key: "google/gemma-4-e4b", size_bytes: 6861915950, loaded_instances: [], max_context_length: 131072 },
    ],
  };

  it("separates the model maximum from the loaded context window", async () => {
    const { fn, calls } = fakeFetch({ "/api/v1/models": () => json(v1) });
    const p = new LMStudioProvider({ baseUrl: "http://localhost:1235/v1", fetchImpl: fn });
    expect(await p.modelInfo("qwen/qwen3.5-9b")).toEqual({
      id: "qwen/qwen3.5-9b",
      state: "loaded",
      maxContext: 262144,
      loadedContext: 60928,
      sizeBytes: 5977257833,
      architecture: "qwen3_5",
      quantization: "4bit",
      parameters: "9B",
    });
    const unloaded = await p.modelInfo("google/gemma-4-e4b");
    expect(unloaded.state).toBe("not-loaded");
    expect(unloaded.maxContext).toBe(131072);
    expect(unloaded.loadedContext).toBeUndefined(); // not allocated, so not reported
    expect(unloaded.memoryBytes).toBeUndefined(); // LM Studio doesn't report memory
    expect(calls.every((c) => c === "/api/v1/models")).toBe(true);
  });

  it("falls back to the v0 REST API on older versions", async () => {
    const { fn } = fakeFetch({
      "/api/v0/models": () =>
        json({
          data: [
            { id: "a", state: "loaded", max_context_length: 32768, loaded_context_length: 8192, arch: "llama", quantization: "Q4_K_M" },
            { id: "b", state: "not-loaded", max_context_length: 4096 },
          ],
        }),
    });
    const p = new LMStudioProvider({ baseUrl: "http://localhost:1234/v1", fetchImpl: fn });
    expect(await p.modelInfo("a")).toMatchObject({ state: "loaded", maxContext: 32768, loadedContext: 8192, architecture: "llama" });
    expect(await p.modelInfo("b")).toMatchObject({ state: "not-loaded", maxContext: 4096 });
    expect((await p.modelInfo("b")).loadedContext).toBeUndefined();
    expect(await p.modelInfo("missing")).toEqual({ id: "missing", state: "unknown" });
  });
});

describe("model metrics: Ollama", () => {
  const show = {
    model_info: { "general.architecture": "llama", "llama.context_length": 131072 },
    details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" },
    parameters: 'num_ctx                        4096\nstop                           "<|eot_id|>"',
  };

  it("reads /api/ps for load state, memory and allocated context, /api/show for limits", async () => {
    let showBody: unknown;
    const { fn, calls } = fakeFetch({
      "/api/ps": () => json({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b", size: 4_000_000_000, size_vram: 3_000_000_000, context_length: 8192 }] }),
      "/api/show": (init) => {
        showBody = JSON.parse(String(init?.body));
        expect(init?.method).toBe("POST");
        return json(show);
      },
    });
    const p = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434/v1", fetchImpl: fn });
    expect(await p.modelInfo("llama3.2:3b")).toEqual({
      id: "llama3.2:3b",
      state: "loaded",
      maxContext: 131072,
      loadedContext: 8192,
      memoryBytes: 4_000_000_000,
      vramBytes: 3_000_000_000,
      architecture: "llama",
      quantization: "Q4_K_M",
      parameters: "3.2B",
    });
    expect(showBody).toEqual({ model: "llama3.2:3b" });
    expect(new Set(calls)).toEqual(new Set(["/api/ps", "/api/show"]));
  });

  it("uses the model's num_ctx when not loaded, and reports what it can when one endpoint fails", async () => {
    const p = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetchImpl: fakeFetch({ "/api/ps": () => json({ models: [] }), "/api/show": () => json(show) }).fn,
    });
    const info = await p.modelInfo("llama3.2:3b");
    expect(info).toMatchObject({ state: "not-loaded", maxContext: 131072, loadedContext: 4096 });
    expect(info.memoryBytes).toBeUndefined();

    const noShow = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetchImpl: fakeFetch({ "/api/ps": () => json({ models: [] }), "/api/show": never }).fn,
    });
    expect(await noShow.modelInfo("x")).toEqual({ id: "x", state: "not-loaded" });

    const down = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434/v1", fetchImpl: fakeFetch({}).fn });
    await expect(down.modelInfo("x")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("model metrics: vLLM", () => {
  const prom = [
    "# HELP vllm:num_requests_running Number of requests running.",
    "# TYPE vllm:num_requests_running gauge",
    'vllm:num_requests_running{engine="0",model_name="meta/llama"} 2.0',
    'vllm:num_requests_waiting{engine="0",model_name="meta/llama"} 1.0',
    'vllm:kv_cache_usage_perc{engine="0",model_name="meta/llama"} 0.375',
    'vllm:secret_internal_path{path="/home/x"} 1',
    "process_resident_memory_bytes 123456",
  ].join("\n");

  it("reports max_model_len as the configured window and reads Prometheus only when enabled", async () => {
    const routes = { "/v1/models": () => json({ data: [{ id: "meta/llama", max_model_len: 16384 }] }), "/metrics": () => new Response(prom) };
    const off = fakeFetch(routes);
    const p = new VLLMProvider({ baseUrl: "http://localhost:8000/v1", fetchImpl: off.fn });
    expect(await p.modelInfo("meta/llama")).toEqual({ id: "meta/llama", state: "loaded", loadedContext: 16384 });
    expect((await p.modelInfo("meta/llama")).maxContext).toBeUndefined(); // vLLM doesn't expose the model's own maximum
    expect(await p.engineStats()).toBeNull();
    expect(off.calls).not.toContain("/metrics");

    const on = fakeFetch(routes);
    const q = new VLLMProvider({ baseUrl: "http://localhost:8000/v1", fetchImpl: on.fn, engineMetrics: true });
    expect(await q.engineStats()).toEqual({ kvCacheUsage: 0.375, requestsRunning: 2, requestsWaiting: 1 });
  });

  it("parses only allowlisted Prometheus samples", () => {
    const m = parsePrometheus(prom + '\nvllm:num_requests_running{engine="1"} 3', ["vllm:num_requests_running", "vllm:gpu_cache_usage_perc"]);
    expect([...m.entries()]).toEqual([["vllm:num_requests_running", 5]]);
  });
});

describe("model metrics: generic OpenAI-compatible", () => {
  it("exposes only what /v1/models carries, never invented values", async () => {
    const { fn, calls } = fakeFetch({
      "/v1/models": () => json({ data: [{ id: "plain", object: "model" }, { id: "llamacpp", meta: { n_ctx_train: 32768, n_params: 8_030_000_000, size: 4_920_000_000 } }] }),
    });
    const p = createProvider("openai-compatible", { baseUrl: "http://localhost:8080/v1", fetchImpl: fn });
    expect(await p.modelInfo("plain")).toEqual({
      id: "plain",
      state: "unknown",
      maxContext: undefined,
      loadedContext: undefined,
      sizeBytes: undefined,
      parameters: undefined,
    });
    expect(await p.modelInfo("llamacpp")).toMatchObject({ maxContext: 32768, sizeBytes: 4_920_000_000, parameters: "8.0B" });
    expect(await p.engineStats()).toBeNull();
    expect(p.metricsSupport).toEqual({ loadState: false, maxContext: false, loadedContext: false, memory: false, engineStats: false });
    expect(new Set(calls)).toEqual(new Set(["/v1/models"]));
  });

  it("reports reasoning tokens from usage details", async () => {
    const { fn } = fakeFetch({
      "/v1/chat/completions": () =>
        sse([
          { choices: [{ delta: { content: "ok" } }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 299, completion_tokens_details: { reasoning_tokens: 297 } } },
          "[DONE]",
        ]),
    });
    const p = createProvider("openai-compatible", { baseUrl: "http://localhost:8080/v1", fetchImpl: fn });
    const chunks = await collect(p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, new AbortController().signal));
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 299, reasoningTokens: 297 } });
  });
});
