# RelayLLM

**Use the private AI running on your own computer from anywhere, with no port forwarding, VPN, or cloud server.**

RelayLLM has two parts:

* **Worker:** a small command-line service that runs next to LM Studio / Bionic, Ollama, vLLM, or any OpenAI-compatible engine.
* **Client:** a static chat web app you can host on GitHub Pages.

They talk only through end-to-end encrypted [Nostr](https://nostr.com) messages relayed by public Nostr relays. Relays see encrypted blobs, never your prompts or answers. Both sides make outbound connections only.

> Install the worker, get its pairing link, open the client, and chat with your private AI from anywhere.

## Quick start

### 1. Worker (on the machine running your AI)

```bash
brew install node@22 pnpm          # macOS; Node.js 22+ and pnpm on Linux
git clone <this repo> relayllm && cd relayllm
./scripts/install-worker.sh
relayllm init                       # pick engine, models, relays; prints a pairing link + QR
relayllm start
```

### 2. Client

Open the pairing link on any device, create an identity (just a password), confirm the worker, and start chatting. The link contains a single-use invite, so access is granted automatically.

Without a link: open your client URL, choose **Add worker**, and paste the worker's npub and relays (shown by `relayllm pair`). Then press **Request access** and approve yourself on the worker with `relayllm users approve <npub>`.

### 3. Host the client

See [docs/deploy-github-pages.md](docs/deploy-github-pages.md). In short: push the repo, enable Pages with the included workflow, then run `relayllm client-url https://<you>.github.io/<repo>/`.

## Features

* Engines: LM Studio / Bionic, Ollama, vLLM, and any OpenAI-compatible `/v1` API. Model discovery, explicit per-model exposure, health checks.
* Streaming answers batched about every 250 ms, a separate "reasoning" stream, stop/cancel that stops the engine, and automatic recovery of lost or out-of-order chunks.
* Private by default: an allowlist of user npubs, single-use expiring invites, approval of pending requests from the CLI. Optional public mode with quotas.
* A chat UI comparable to modern assistants: conversation history, rename/delete, markdown with highlighted code, copy, regenerate, multiple workers and models, dark/light themes, mobile layout.
* Per-conversation system prompts. Set one under **Advanced settings** in a new chat, or start from a template (Spanish ⇄ English translator, American War of Independence fiction writer, sponsor–child correspondence reviewer). Edit it mid-conversation with the sliders button; used prompts are kept in an encrypted library, and a default can be set for new chats.
* A context indicator next to the model selector shows how much of the model's loaded context window the conversation uses. Click it for model details (maximum vs. loaded context, load state, memory), the latest generation speed, and, if the worker owner enables `relayllm monitoring on`, the machine's RAM, swap and memory pressure.
* Local-only history in IndexedDB, encrypted at rest. Identities are protected with NIP-49 or kept in a NIP-07 extension.
* A command and Node library, `relayllm-api`, for calling the worker from scripts, with JSON output that follows a schema and resumable batches.
* No telemetry and no RelayLLM account or server.

## Documentation

| | |
|---|---|
| [docs/worker.md](docs/worker.md) | Worker installation, CLI, Bionic/Ollama notes, background service, limits |
| [docs/deploy-github-pages.md](docs/deploy-github-pages.md) | Hosting the client |
| [docs/api.md](docs/api.md) | Calling a worker from programs and scripts, JSON output |
| [docs/reasoning.md](docs/reasoning.md) | Reasoning control, timeouts, cancellation, live statistics |
| [docs/architecture.md](docs/architecture.md) | Design, transport choice (NIP-44, gift wrap, ContextVM, NIP-90), streaming |
| [docs/protocol.md](docs/protocol.md) | Message schemas |
| [docs/security.md](docs/security.md) | Threat model, metadata exposure, residual risks |

## Development

```bash
pnpm install
pnpm test               # unit + integration tests (mock relay + mock engine, no GPU needed)
pnpm test:browser       # builds the client and runs it in headless Chromium
                        # (first time: pnpm exec playwright install chromium)
pnpm typecheck
```

A fully local stack, with no internet and no GPU:

```bash
pnpm dev:relay                       # ws://127.0.0.1:7777
pnpm dev:mock-provider               # http://127.0.0.1:1299/v1
RELAYLLM_HOME=.relayllm-dev pnpm worker init --yes --provider openai-compatible \
  --url http://127.0.0.1:1299/v1 --relays ws://127.0.0.1:7777 \
  --client-url http://localhost:5173/ --key-storage file
RELAYLLM_HOME=.relayllm-dev pnpm worker start
pnpm dev:client                      # open the pairing link printed by init
```

Live smoke test against a real engine and relay:

```bash
PROVIDER_URL=http://localhost:1235/v1 RELAY=wss://relay.k1.sv MODEL=qwen/qwen3.5-9b \
  pnpm exec tsx apps/worker/scripts/live-smoke.ts
```

### Layout

```
apps/client               React + Vite static web app
apps/api                  relayllm-api command and Node library
apps/worker               CLI, config, secrets, access control, gateway
packages/protocol         message schemas and validation
packages/nostr-transport  encryption, relay pool, fragmentation, pairing, WorkerClient
packages/provider-adapters  LM Studio / Ollama / vLLM / OpenAI-compatible adapters
packages/test-utils       mock relay and mock engine
docs/                     documentation
```

## Status

MVP. It is tested end to end against Bionic on Apple Silicon over a public relay. It has not had an independent security audit; read [docs/security.md](docs/security.md).
