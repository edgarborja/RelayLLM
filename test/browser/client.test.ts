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
import { MockProvider, MockRelay, type MockStep } from "@relayllm/test-utils";
import { buildPairingUrl } from "@relayllm/nostr-transport";
import { TEMPLATES } from "../../apps/client/src/lib/prompts.ts";
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
let hostSamples = 0;

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
    reasoningOptions: ["off", "on"],
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
  config.provider = { kind: "lmstudio", baseUrl: provider.baseUrl, allowRemoteEndpoint: false, streaming: true, hasApiKey: false, systemPromptStyle: "system" };
  config.models.exposed = ["mock-llm-small", "mock-llm-large"];
  config.streaming.batchMs = 100;
  worker = await startWorker({
    config,
    store,
    provider: buildProvider(config, store),
    log: silentLogger,
    writeStatus: false,
    hostSampler: async () => {
      hostSamples++;
      return {
        at: Date.now(),
        platform: "macos",
        memTotalBytes: 16 * 1024 ** 3,
        memAvailableBytes: 4 * 1024 ** 3,
        memUsedPercent: 75,
        swapTotalBytes: 1024 ** 3,
        swapUsedBytes: 512 * 1024 ** 2,
        pressure: "warning",
      };
    },
  });
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
    await page.getByText("Interrupted. The partial answer was kept.").waitFor({ timeout: 10_000 });
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

  it("sends each conversation's own system prompt, editable mid-conversation, and keeps it across reloads", async () => {
    const translator = TEMPLATES[0]!;
    const lastSent = () => provider.chats.at(-1)!.body.messages as { role: string; content: string }[];
    const chip = page.locator(".system-chip");

    // Conversation 1: a starter template chosen in the new-chat advanced settings.
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByText("Advanced settings").click();
    await page.getByLabel("Insert a prompt…").selectOption({ label: translator.name });
    await expect(page.getByLabel("System prompt", { exact: true }).inputValue()).resolves.toBe(translator.content);
    await sendAndWait(page, "good morning");
    expect(lastSent()).toEqual([
      { role: "system", content: translator.content },
      { role: "user", content: "good morning" },
    ]);
    await expect(chip.textContent()).resolves.toContain(translator.name);

    // Conversation 2: a custom prompt typed in, isolated from conversation 1.
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.locator(".msg").count()).resolves.toBe(0);
    await page.getByText("Advanced settings").click();
    await expect(page.getByLabel("System prompt", { exact: true }).inputValue()).resolves.toBe(""); // not carried over
    await page.getByLabel("System prompt", { exact: true }).fill("You are a pirate.");
    await sendAndWait(page, "ahoy");
    expect(lastSent()).toEqual([
      { role: "system", content: "You are a pirate." },
      { role: "user", content: "ahoy" },
    ]);

    // Edit it mid-conversation: the next request uses the new prompt, history is unchanged.
    await page.getByRole("button", { name: "System prompt", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("System prompt", { exact: true }).fill("You are a pirate captain.");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await sendAndWait(page, "next");
    expect(lastSent()).toEqual([
      { role: "system", content: "You are a pirate captain." },
      { role: "user", content: "ahoy" },
      { role: "assistant", content: "You said: ahoy" },
      { role: "user", content: "next" },
    ]);
    expect(await page.locator(".msg.user .bubble").allTextContents()).toEqual(["ahoy", "next"]);

    // Back in conversation 1, its own prompt is still used.
    await page.locator(".conv-title", { hasText: "good morning" }).click();
    await expect(chip.textContent()).resolves.toContain(translator.name);
    await sendAndWait(page, "thank you");
    expect(lastSent()[0]).toEqual({ role: "system", content: translator.content });
    expect(JSON.stringify(lastSent())).not.toContain("pirate");

    // Used prompts show up in the library (templates aren't duplicated there).
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Manage…" }).click();
    const lib = page.getByRole("dialog", { name: "System prompts" });
    await expect(lib.locator(".prompt-row summary").allTextContents()).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining("You are a pirate captain."), expect.stringContaining("You are a pirate.")]),
    );
    // Make the pirate captain prompt the default for new chats.
    await lib.getByLabel("Change…").selectOption({ label: "You are a pirate captain." });
    await lib.getByRole("button", { name: "Close" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.locator(".advanced summary").textContent()).resolves.toContain("System prompt: You are a pirate captain.");

    // Persisted (encrypted) across a reload.
    await page.reload();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.locator(".conv-title", { hasText: "ahoy" }).click();
    await expect(chip.textContent()).resolves.toContain("You are a pirate captain.");
    expect(await page.evaluate(() => localStorage.getItem("relayllm.prefs.v1") ?? "")).not.toContain("pirate");
  }, 60_000);

  it("shows context usage next to the model and a details panel that polls machine stats only while open", async () => {
    const ctx = await browser.newContext();
    const p4 = await ctx.newPage();
    const invite = createInvite(config, 600, "metrics");
    await p4.goto(buildPairingUrl(baseUrl, { workerPubkey: worker.pubkey, relays: [relay.url], name: "Test Box", invite }));
    await createIdentity(p4);
    await p4.getByRole("dialog").getByRole("button", { name: "Add worker" }).click();
    await p4.getByPlaceholder("Message…").waitFor({ timeout: 15_000 });

    const indicator = p4.getByRole("button", { name: "Context usage" });
    await indicator.waitFor();
    await expect.poll(() => indicator.textContent()).toBe("0%"); // loaded window known (4,096), nothing sent yet

    // A 2,000-character message; the mock replies with 600 words (long enough to time the speed).
    await sendAndWait(p4, `long ${"x".repeat(1995)}`);
    // 504 prompt tokens + 600 visible output tokens (3 reasoning tokens aren't sent back) of 4,096.
    await expect.poll(() => indicator.textContent()).toBe("27%");

    await indicator.click();
    const panel = p4.getByRole("dialog", { name: "Context and model details" });
    await panel.getByText("Loaded context").waitFor();
    const text = async () => (await panel.textContent()) ?? "";
    await expect.poll(text).toContain("~1,104 of 4,096 tokens (27%)");
    const t = await text();
    expect(t).toContain("Loaded context4,096 tokens");
    expect(t).toContain("Model maximum32,768 tokens (not all allocated)");
    expect(t).toContain("Memory in useUnavailable"); // LM Studio doesn't report it: not shown as zero
    expect(t).toContain("504 in · 603 out (3 reasoning) · measured");
    expect(t).toMatch(/Speed[\d.]+ tokens\/s · first token/);
    expect(t).toContain("Machine monitoring is off");
    expect(hostSamples).toBe(0);

    // Owner enables monitoring (relayllm monitoring on --interval 2); reopen the panel.
    config.monitoring.host = true;
    config.monitoring.intervalSec = 2;
    await indicator.click(); // close
    await indicator.click(); // open
    await expect.poll(text, { timeout: 10_000 }).toContain("Memory used12.0 GB of 16.0 GB (75%)");
    expect(await text()).toContain("Swap512 MB of 1.0 GB");
    expect(await text()).toContain("Memory pressureWarning");
    await expect.poll(() => hostSamples, { timeout: 10_000 }).toBeGreaterThanOrEqual(3); // refreshed every 2 s while open

    await p4.keyboard.press("Escape");
    await expect(panel.count()).resolves.toBe(0);
    await p4.waitForTimeout(500);
    const after = hostSamples;
    await p4.waitForTimeout(4500);
    expect(hostSamples).toBe(after); // polling stopped when the panel closed

    config.monitoring.host = false;
    await ctx.close();
  }, 60_000);

  it("explains the password requirements while creating an identity", async () => {
    const ctx = await browser.newContext();
    const p5 = await ctx.newPage();
    await p5.goto(baseUrl);
    await p5.getByRole("button", { name: "Create a new identity" }).click();
    const create = p5.getByRole("button", { name: "Create identity" });
    const pw = p5.getByLabel("Password (protects your key in this browser)");
    await expect(p5.locator("#pw-hint").textContent()).resolves.toBe("At least 8 characters");
    expect(await create.isDisabled()).toBe(true);
    await expect(p5.getByText("Password needs at least 8 characters to continue.").count()).resolves.toBe(1);

    await pw.fill("abcde");
    await expect(p5.locator("#pw-hint").textContent()).resolves.toBe("At least 8 characters (3 more)");
    await pw.fill("abcdefgh");
    await expect(p5.locator("#pw-hint").textContent()).resolves.toBe("✓ At least 8 characters");
    await expect(p5.getByText("Repeat the password to continue.").count()).resolves.toBe(1);

    await p5.getByLabel("Repeat password").fill("abcdefgX");
    await expect(p5.getByText("Passwords don’t match yet").count()).resolves.toBe(1);
    await expect(p5.getByText("Make both passwords match to continue.").count()).resolves.toBe(1);
    expect(await create.isDisabled()).toBe(true);
    await p5.getByLabel("Repeat password").fill("abcdefgh");
    expect(await create.isEnabled()).toBe(true);
    await expect(p5.getByText("to continue.").count()).resolves.toBe(0);
    await ctx.close();
  });

  it("controls reasoning, shows live progress, and explains interrupted or cut-off replies", async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(buildPairingUrl(baseUrl, { workerPubkey: worker.pubkey, relays: [relay.url], name: "Test Box", invite: createInvite(config, 600, "reasoning") }));
    await createIdentity(p);
    await p.getByRole("dialog").getByRole("button", { name: "Add worker" }).click();
    await p.getByPlaceholder("Message…").waitFor({ timeout: 15_000 });
    const script = (fn: () => Iterable<MockStep>) => (provider.opts.script = fn);
    const state = p.locator(".gen-state");
    const shot = (n: string) => (process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${n}.png` }) : undefined);
    const lastMsg = p.locator(".msg.assistant").last();

    // Reasoning off, chosen next to the system prompt in Advanced settings.
    script(() => [{ answer: "quick" }, { finish: "stop" }]);
    await p.getByText("Advanced settings").click();
    await expect(p.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).resolves.toBe("true");
    await p.getByRole("radio", { name: "Off" }).click();
    await shot("r1-selector");
    await sendAndWait(p, "first");
    expect(provider.chats.at(-1)!.body.reasoning_effort).toBe("none");

    // Back to Auto mid-conversation, remembered with the conversation.
    await p.getByRole("button", { name: "System prompt", exact: true }).click();
    const dialog = p.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: "Off" }).getAttribute("aria-checked")).resolves.toBe("true");
    await dialog.getByRole("radio", { name: "Auto" }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    // Thinking is visible before any answer text; Stop keeps the partial answer.
    let answer = false;
    script(function* () {
      yield { wait: 400 };
      while (!answer) {
        yield { reasoning: "considering this carefully. " };
        yield { wait: 50 };
      }
      for (let i = 0; i < 3000; i++) {
        yield { answer: `part${i} ` };
        yield { wait: 50 };
      }
    });
    await p.getByPlaceholder("Message…").fill("think");
    await p.keyboard.press("Enter");
    await expect.poll(() => state.textContent().catch(() => ""), { timeout: 8000 }).toBe("Thinking");
    expect(provider.chats.at(-1)!.body).not.toHaveProperty("reasoning_effort");
    await expect(lastMsg.locator(".markdown").count()).resolves.toBe(0);
    await expect.poll(() => p.locator(".gen-status").textContent(), { timeout: 5000 }).toMatch(/Thinking · [\d.]+ s · ~\d+ reasoning tokens · ~[\d.]+ tok\/s/);
    await shot("r2-thinking");
    answer = true;
    await expect.poll(() => state.textContent(), { timeout: 8000 }).toBe("Generating answer");
    await expect.poll(() => lastMsg.locator(".markdown").textContent()).toContain("part3");
    const chat = provider.chats.at(-1)!;
    await p.getByRole("button", { name: "Stop generating" }).click();
    await lastMsg.getByText("Interrupted. The partial answer was kept.").waitFor();
    const kept = await lastMsg.locator(".markdown").textContent();
    await expect.poll(() => chat.aborted).toBe(true);
    await p.waitForTimeout(500);
    expect(await lastMsg.locator(".markdown").textContent()).toBe(kept);
    await expect(lastMsg.getByText("did not confirm").count()).resolves.toBe(0);

    // Budget used up by reasoning: says exactly that, not "timeout".
    script(() => [
      { reasoning: "thinking and thinking" },
      { finish: "length" },
      { usage: { prompt_tokens: 20, completion_tokens: 3900, completion_tokens_details: { reasoning_tokens: 3900 } } },
    ]);
    config.limits.maxTokens = 3900;
    await sendAndWait(p, "hard question");
    const text = (await lastMsg.textContent()) ?? "";
    expect(text).toContain("The generation budget (3,900 tokens) was used up by reasoning before an answer was produced.");
    expect(text).not.toMatch(/time/i);
    await shot("r3-budget");
    config.limits.maxTokens = 16_384;

    // A reload stops the orphaned request and keeps what was received.
    script(function* () {
      for (let i = 0; i < 3000; i++) {
        yield { answer: `live${i} ` };
        yield { wait: 50 };
      }
    });
    await p.getByPlaceholder("Message…").fill("reload me");
    await p.keyboard.press("Enter");
    await expect.poll(() => lastMsg.locator(".markdown").textContent().catch(() => ""), { timeout: 8000 }).toContain("live3");
    await p.waitForTimeout(1800); // text is saved periodically
    const orphan = provider.chats.at(-1)!;
    await p.reload();
    await p.getByLabel("Password").fill(PASSWORD);
    await p.getByRole("button", { name: "Unlock" }).click();
    await expect.poll(() => orphan.aborted, { timeout: 10_000 }).toBe(true);
    await p.locator(".conv-title").first().click();
    await lastMsg.getByText("Interrupted. The partial answer was kept.").waitFor();
    expect(await lastMsg.locator(".markdown").textContent()).toContain("live3");

    provider.opts.script = undefined;
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);
});
