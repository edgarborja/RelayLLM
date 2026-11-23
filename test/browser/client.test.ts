/**
 * Browser end-to-end test: the built static client in headless Chromium,
 * talking to an in-process worker through a local mock relay.
 *
 *   pnpm test:browser      (builds the client first)
 */
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { MockProvider, MockRelay } from "@relayllm/test-utils";
import { buildPairingUrl } from "@relayllm/nostr-transport";
import { createInvite } from "../../apps/worker/src/access.ts";
import { defaultConfig, type Config } from "../../apps/worker/src/config.ts";
import { silentLogger } from "../../apps/worker/src/log.ts";
import { MemoryStore, SECRET_WORKER_KEY } from "../../apps/worker/src/secrets.ts";
import { buildProvider, startWorker, type RunningWorker } from "../../apps/worker/src/worker.ts";

const DIST = join(import.meta.dirname, "../../apps/client/dist");
const PASSWORD = "browser test password";

const MALICIOUS =
  'Here is **bold** text.\n\n<img src="http://127.0.0.1:9/pixel.png" onerror="window.__pwned=1">\n\n<script>window.__pwned=2</script>\n\n![tracker](http://127.0.0.1:9/track.png)\n\n[click](javascript:window.__pwned=3)\n\n```js\nconsole.log("hi")\n```';

let relay: MockRelay;
let provider: MockProvider;
let worker: RunningWorker;
let config: Config;
let server: Server;
let baseUrl: string;
let browser: Browser;

function serveStatic(): Promise<Server> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  const s = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, path === "/" ? "index.html" : path);
    if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, "index.html");
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("Build the client first: pnpm --filter @relayllm/client build");
  relay = await MockRelay.start();
  provider = await MockProvider.start({
    tokenDelayMs: 8,
    reasoning: "considering the question",
    reply: (m) => {
      const last = m.filter((x) => x.role === "user").at(-1)?.content ?? "";
      if (last.includes("malicious")) return MALICIOUS;
      if (last.includes("long")) return Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
      return `You said: ${last}`;
    },
  });
  const store = new MemoryStore();
  store.set(SECRET_WORKER_KEY, "1".repeat(63) + "2");
  config = defaultConfig({ name: "Test Box", keyStorage: "file", relays: [relay.url] });
  config.provider = { kind: "lmstudio", baseUrl: provider.baseUrl, allowRemoteEndpoint: false, streaming: true, hasApiKey: false };
  config.models.exposed = ["mock-llm-small", "mock-llm-large"];
  config.streaming.batchMs = 100;
  worker = await startWorker({ config, store, provider: buildProvider(config, store), log: silentLogger, writeStatus: false });
  server = await serveStatic();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  await worker?.stop();
  await provider?.close();
  await relay?.close();
});

async function createIdentity(page: Page) {
  await page.getByRole("button", { name: "Create a new identity" }).click();
  await page.getByLabel("Password (protects your key in this browser)").fill(PASSWORD);
  await page.getByLabel("Repeat password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create identity" }).click();
}

async function sendAndWait(page: Page, text: string) {
  await page.getByPlaceholder("Message…").fill(text);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 30_000 });
}

describe("static web client", () => {
  let page: Page;

  it("pairs via invite link, streams a chat, and renders markdown safely", async () => {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const invite = createInvite(config, 600, "browser");
    const url = buildPairingUrl(baseUrl, { workerPubkey: worker.pubkey, relays: [relay.url], name: "Test Box", invite });
    await page.goto(url);
    // Pairing parameters are removed from the address bar immediately.
    expect(page.url()).toBe(baseUrl);

    await createIdentity(page);
    await page.getByRole("dialog").getByRole("button", { name: "Add worker" }).click();
    await page.getByPlaceholder("Message…").waitFor({ timeout: 15_000 });
    expect(config.access.users).toHaveLength(1);

    await sendAndWait(page, "hello there");
    await expect(page.locator(".msg.assistant .markdown").last().textContent()).resolves.toContain("You said: hello there");
    await expect(page.locator(".reasoning summary").last().textContent()).resolves.toBe("Reasoning");

    await sendAndWait(page, "malicious please");
    const last = page.locator(".msg.assistant").last();
    await expect(last.locator("strong").textContent()).resolves.toBe("bold");
    expect(await last.locator("img").count()).toBe(0); // no images loaded at all
    expect(await last.locator("script").count()).toBe(0);
    expect(await last.locator(".code-block").count()).toBe(1);
    const hrefs = await last.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs.some((h) => h?.startsWith("javascript:"))).toBe(false);
    await last.locator("a", { hasText: "click" }).click().catch(() => undefined);
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  }, 60_000);

  it("stops generation and the worker cancels the provider request", async () => {
    await page.getByPlaceholder("Message…").fill("make it long");
    await page.keyboard.press("Enter");
    await page.locator(".msg.assistant .markdown").last().waitFor();
    await page.waitForFunction(() => (document.querySelector(".msg.assistant:last-child .markdown")?.textContent?.length ?? 0) > 50);
    await page.getByRole("button", { name: "Stop generating" }).click();
    await page.getByText("Stopped.").waitFor({ timeout: 10_000 });
    const entry = provider.chats.at(-1)!;
    await expect.poll(() => entry.aborted, { timeout: 5000 }).toBe(true);
    expect(entry.tokensSent).toBeLessThan(600);
  }, 30_000);

  it("persists conversations across reloads (after unlocking)", async () => {
    await page.reload();
    await page.getByLabel("Password").fill("wrong password!");
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByText("Incorrect password.").waitFor({ timeout: 15_000 });
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.locator(".conv-title").first().click();
    await expect(page.locator(".msg.user .bubble").first().textContent()).resolves.toBe("hello there");
    expect(await page.locator(".msg").count()).toBe(6);
  }, 30_000);

  it("shows approval-required to an unauthorized identity, then works once approved", async () => {
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await p2.goto(buildPairingUrl(baseUrl, { workerPubkey: worker.pubkey, relays: [relay.url], name: "Test Box" }));
    await createIdentity(p2);
    await p2.getByRole("dialog").getByRole("button", { name: "Add worker" }).click();
    await p2.getByRole("heading", { name: "Access approval required" }).waitFor({ timeout: 15_000 });
    expect(await p2.getByPlaceholder("Message…").count()).toBe(0);
    expect(provider.chats.length).toBe(3);

    await p2.getByRole("button", { name: "Request access" }).click();
    await p2.getByRole("heading", { name: "Waiting for approval" }).waitFor({ timeout: 10_000 });
    expect(config.access.pending).toHaveLength(1);

    // Owner approves (what `relayllm users approve` does).
    const pending = config.access.pending.shift()!;
    config.access.users.push({ pubkey: pending.pubkey, addedAt: Date.now() });
    await p2.getByRole("button", { name: "Check again" }).click();
    await p2.getByPlaceholder("Message…").waitFor({ timeout: 10_000 });
    await sendAndWait(p2, "approved now");
    await expect(p2.locator(".msg.assistant .markdown").last().textContent()).resolves.toContain("You said: approved now");
    await ctx.close();
  }, 60_000);

  it("works on a phone-sized screen in dark mode", async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", hasTouch: true });
    const p3 = await ctx.newPage();
    await p3.goto(baseUrl);
    const bg = await p3.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe("rgb(255, 255, 255)");
    const overflow = await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await ctx.close();
  });
});
