import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Mock OpenAI-compatible inference server (LM Studio flavoured).
 * Streams a deterministic reply token by token so the full protocol can be
 * tested without a GPU.
 */

export interface MockProviderOptions {
  port?: number;
  models?: { id: string; type?: string }[];
  /** Reply text for a request; default echoes the last user message. */
  reply?: (messages: { role: string; content: string }[]) => string;
  reasoning?: string;
  tokenDelayMs?: number;
  /** Respond with this HTTP status to chat requests. */
  failWith?: number;
  /** Never respond to chat requests (timeout testing). */
  hang?: boolean;
  apiKey?: string;
}

export interface ChatLogEntry {
  body: Record<string, unknown>;
  aborted: boolean;
  tokensSent: number;
  finished: boolean;
}

export class MockProvider {
  readonly #server: Server;
  readonly opts: MockProviderOptions;
  readonly chats: ChatLogEntry[] = [];
  /** Every path requested, for allowlist assertions. */
  readonly requests: { method: string; path: string }[] = [];
  baseUrl = "";

  private constructor(opts: MockProviderOptions) {
    this.opts = opts;
    this.#server = createServer((req, res) => void this.#handle(req, res));
  }

  static async start(opts: MockProviderOptions = {}): Promise<MockProvider> {
    const p = new MockProvider(opts);
    await new Promise<void>((r) => p.#server.listen(opts.port ?? 0, "127.0.0.1", () => r()));
    p.baseUrl = `http://127.0.0.1:${(p.#server.address() as AddressInfo).port}/v1`;
    return p;
  }

  get models(): { id: string; type?: string }[] {
    return (
      this.opts.models ?? [
        { id: "mock-llm-small", type: "llm" },
        { id: "mock-llm-large", type: "llm" },
        { id: "mock-embed", type: "embeddings" },
      ]
    );
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0]!;
    this.requests.push({ method: req.method ?? "", path });
    if (this.opts.apiKey && req.headers.authorization !== `Bearer ${this.opts.apiKey}`) {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && path === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: this.models.map((m) => ({ id: m.id, object: "model" })) }));
      return;
    }
    if (req.method === "GET" && path === "/api/v0/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: this.models.map((m) => ({ id: m.id, type: m.type ?? "llm", state: "loaded", max_context_length: 8192 })),
        }),
      );
      return;
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      const entry: ChatLogEntry = { body, aborted: false, tokensSent: 0, finished: false };
      this.chats.push(entry);
      if (this.opts.hang) {
        res.on("close", () => (entry.aborted = true));
        return;
      }
      if (this.opts.failWith) {
        res.writeHead(this.opts.failWith, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "secret internal detail /Users/x/models" } }));
        return;
      }
      const messages = body.messages as { role: string; content: string }[];
      const text = this.opts.reply
        ? this.opts.reply(messages)
        : `Echo: ${messages.filter((m) => m.role === "user").at(-1)?.content ?? ""}`;
      const tokens = text.match(/\S+\s*|\s+/g) ?? [];
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: tokens.length },
          }),
        );
        entry.finished = true;
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.on("close", () => {
        if (!entry.finished) entry.aborted = true;
      });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const delay = this.opts.tokenDelayMs ?? 5;
      const pieces: { reasoning?: string; content?: string }[] = [];
      if (this.opts.reasoning) for (const t of this.opts.reasoning.match(/\S+\s*/g) ?? []) pieces.push({ reasoning: t });
      for (const t of tokens) pieces.push({ content: t });
      for (const p of pieces) {
        if (entry.aborted || res.destroyed) return;
        const delta = p.reasoning ? { reasoning_content: p.reasoning } : { content: p.content };
        send({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] });
        entry.tokensSent++;
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      send({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      send({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 5, completion_tokens: tokens.length } });
      res.write("data: [DONE]\n\n");
      entry.finished = true;
      res.end();
      return;
    }
    res.writeHead(404).end();
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
}
