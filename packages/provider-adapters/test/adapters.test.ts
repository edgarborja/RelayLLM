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
    expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "stop", usage: { completionTokens: 2 } });
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
