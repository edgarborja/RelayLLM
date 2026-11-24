# RelayLLM Worker guide

## Requirements

* macOS or Linux with Node.js 22 or newer (`brew install node@22 pnpm` on macOS)
* A local engine with an OpenAI-compatible API: LM Studio / Bionic, Ollama, vLLM, llama.cpp server, etc.

## Install

```bash
git clone <this repo> relayllm && cd relayllm
./scripts/install-worker.sh        # builds and installs the `relayllm` command
```

## Set up

```bash
relayllm init
```

The guided setup:

1. Asks which engine you use, then probes its usual local addresses. LM Studio / Bionic: `localhost:1234` and `localhost:1235`. Ollama: `localhost:11434`. vLLM: `localhost:8000`. You can type any other address. Include `/v1`.
2. Asks for an API key if the engine needs one. It's stored in the Keychain, never in the config file.
3. Lists the discovered models and asks which ones to expose. Embedding models are hidden automatically.
4. Generates the worker's Nostr identity, or imports an nsec.
5. Asks for relays. Use 2–3; the defaults are `wss://relay.k1.sv`, `wss://nos.lol` and `wss://relay.damus.io`.
6. Asks for the URL of your hosted web client (see [deploy-github-pages.md](deploy-github-pages.md)). This may be empty for now.
7. Prints a pairing link and QR code containing a single-use invite valid for 7 days. Open it on your phone or laptop, create an identity, and you're in.

Then run it:

```bash
relayllm start
```

No firewall rules, port forwarding or public IP are needed. The worker only makes outbound connections to the relays.

### Bionic / LM Studio notes

* Enable the local server in Bionic / LM Studio ("Developer → Start server"). Check the port it shows, since it's often 1234 or 1235.
* Models that aren't loaded are loaded on first use (JIT), so the first reply can take longer.
* Reasoning models (e.g. Qwen 3.x) stream their thinking separately; the client shows it in a collapsible "Reasoning" section. Thinking counts against `limits.maxTokens` (default 16384). See [reasoning.md](reasoning.md) for reasoning control and timeouts.
* RelayLLM never enables Bionic's tools, MCP or filesystem features. It only calls chat completions.

## Everyday commands

| Task | Command |
|---|---|
| Status of process, relays and engine | `relayllm status` |
| Pairing link / QR, without an invite | `relayllm pair` |
| Pairing link with a one-time invite (valid 7 days; `--ttl 2h` etc. to change) | `relayllm pair --invite --label "Anna's phone"` |
| Who has access, and pending requests | `relayllm users` |
| Approve a request | `relayllm users approve npub1…` |
| Add / remove a user directly | `relayllm users add npub1… --label laptop` / `relayllm users remove npub1…` |
| List models | `relayllm models` |
| Expose / hide a model | `relayllm models enable <id>` / `relayllm models disable <id>` |
| Model that discovery can't see | `relayllm models add <id>` |
| Relays | `relayllm relays`, `relayllm relays add wss://…`, `relayllm relays remove wss://…` |
| Change engine | `relayllm provider set --kind ollama --url http://localhost:11434/v1` |
| Engine API key | `relayllm provider set --api-key` (hidden prompt) |
| How system prompts reach the engine | `relayllm provider set --system-style system\|developer\|user-prefix` |
| …for one model only | `relayllm models system-style <id> user-prefix` (`default` to reset) |
| Generation budget and timeouts | `relayllm limits --max-tokens 16384 --absolute 1800 --inactivity 120` |
| Reasoning control (vLLM, generic) | `relayllm models reasoning <id> toggle` (or `effort`) |
| Share machine memory stats with authorized users | `relayllm monitoring on` (`off` to stop; `--interval 10`) |
| vLLM KV-cache / queue stats | `relayllm monitoring --engine-metrics on` (restart needed) |
| Web client URL for links | `relayllm client-url https://you.github.io/relayllm/` |
| Show worker npub | `relayllm identity` |
| New worker identity | `relayllm identity rotate` |

User, model and access changes apply to a running worker within about 2 seconds. Relay and provider changes need a restart.

## Access control

* **Private (default):** only listed npubs can use the worker. Unknown users get "access approval required" and nothing else; no model list or configuration is revealed. Their "Request access" button adds them to `relayllm users` as pending.
* **Public:** `relayllm access public` lets anyone use the exposed models, subject to `limits.publicRequestsPerMinute` and `limits.publicRequestsPerDay`.

## Limits (`~/.relayllm/config.json`)

```jsonc
"limits": {
  "maxConcurrent": 2,            // simultaneous generations
  "perUserConcurrent": 1,
  "requestsPerMinute": 20,       // per authorized user
  "publicRequestsPerMinute": 4,  // per public user
  "publicRequestsPerDay": 100,
  "requestTimeoutSec": 1800,     // absolute limit per request
  "inactivityTimeoutSec": 120,   // no new text, once text has started
  "heartbeatSec": 10,
  "maxRequestBytes": 400000,     // conversation context per request
  "maxMessages": 200,
  "maxResponseChars": 200000,
  "maxTokens": 16384,            // generation budget: reasoning + answer
  "maxSystemPromptChars": 32000  // total length of a conversation's system prompt
},
"monitoring": { "host": false, "intervalSec": 10, "engineMetrics": false },
"streaming": { "batchMs": 250, "maxBatchChars": 4000, "resumeBufferSec": 180 }
```

## System prompts

Users can give each conversation a system prompt in the web client. It arrives as the first message of each chat request. It only instructs the model; access, exposed models, limits and provider settings always come from this worker's config.

Engines differ in how they accept system instructions, so you choose the convention. The client can't:

| Style | Sent to the engine as | Use for |
|---|---|---|
| `system` (default) | a leading `{"role": "system"}` message | LM Studio / Bionic, Ollama, vLLM, most models |
| `developer` | a leading `{"role": "developer"}` message | servers that follow OpenAI's newer convention |
| `user-prefix` | text prepended to the first user message | chat templates that reject the system role (some Gemma/Mistral builds return HTTP 400) |

Set it for the whole engine with `relayllm provider set --system-style …` (restart needed), or per model with `relayllm models system-style <id> …` (applies within a few seconds).

## Context and resource monitoring

The web client shows a small context indicator next to the model selector.
Clicking it opens a panel with:

* this conversation's context use, against the model's **loaded** context window;
* the model's maximum context, load state, size and memory;
* the latest generation speed;
* optionally, this machine's memory.

What each engine reports (anything missing is shown as "Unavailable"):

| | Load state | Max context | Loaded context | Model memory | Token usage |
|---|---|---|---|---|---|
| LM Studio / Bionic | ✓ (`/api/v1/models`, fallback `/api/v0/models`) | ✓ | ✓ | – (size on disk) | ✓ incl. reasoning |
| Ollama | ✓ (`/api/ps`) | ✓ (`/api/show`) | ✓ (`/api/ps`, or the model's `num_ctx`) | ✓ (incl. GPU) | ✓ |
| vLLM | ✓ (served = loaded) | – | ✓ (`max_model_len`) | – | ✓; KV cache via `/metrics` if enabled |
| Other OpenAI-compatible | – | only if `/v1/models` says (llama.cpp) | – | – | if the server sends `usage` |

When an engine reports no token usage, the worker estimates it from text
length, and the client labels the numbers as estimated. Generation speed is
timed by the worker.

**Machine monitoring is off by default.** `relayllm monitoring on` shares
these read-only values with authorized users:

* total and available RAM, memory used %, and swap;
* memory pressure: on macOS from `kern.memorystatus_vm_pressure_level`; on Linux from PSI (`/proc/pressure/memory`).

Windows reports RAM only. Nothing else about the machine is exposed: no
processes, paths, environment, or commands.

Stats are read only while a client has the panel open, every
`monitoring.intervalSec` seconds (default 10). Nothing is polled in the
background.

## Run in the background

**macOS (launchd, starts at login):**

```bash
relayllm service launchd --install
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.relayllm.worker.plist
tail -f ~/Library/Logs/relayllm.log
```

The agent runs in your login session, so it can read the Keychain.

**Linux (systemd user service):** `relayllm service systemd` prints a unit file and the commands to enable it. On Linux, keys are stored in `~/.relayllm/secrets` (mode 0600).

## Rotating the worker identity

`relayllm identity rotate` creates a new keypair and deletes the old one. Your authorized-user list is kept, but every client must add the worker again: send them a fresh `relayllm pair --invite` link. Conversations already stored on devices remain readable. Back up the old key first (`relayllm identity import` restores one) if you might need to roll back.

## Files

| Path | Contents |
|---|---|
| `~/.relayllm/config.json` (0600) | Configuration, users, invite hashes |
| `~/.relayllm/status.json` | Live status for `relayllm status` |
| macOS Keychain, service `relayllm-<hash>` | Worker nsec and provider API key |
| `~/.relayllm/secrets/` (0700) | Same, when using file storage |

Set `RELAYLLM_HOME` to run several workers on one machine.

Logs contain request metadata (short ids, model, sizes, timing) but never prompts, responses, or keys. `RELAYLLM_LOG=debug` adds the reasons events were dropped.
