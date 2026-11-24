# RelayLLM protocol v1

The application messages are JSON objects. They travel as the `content` of a
signed inner event inside a NIP-44 encrypted wrap; see
[architecture.md](architecture.md#wire-format). The authoritative schemas are
in `packages/protocol/src/messages.ts`. Receivers validate every message
strictly and reject unknown fields.

## Envelope (every message)

| Field | Type | Notes |
|---|---|---|
| `v` | int | Protocol version. Unsupported versions get `server.error` with `code: "unsupported_version"` and `versions: [...]`. |
| `id` | string | 16–64 URL-safe chars, random (128-bit). Request ids double as stream ids. |
| `exp` | int | Unix seconds. Receivers drop expired messages. At most 600 s in the future. |
| `replyTo` | hex pubkey | *Client requests only.* Key to encrypt responses to (default: sender). |

The sender's identity always comes from the inner event signature. It is never
taken from a message field.

## Client → worker

| type | fields | response |
|---|---|---|
| `server.info` | – | `server.info.result` |
| `models.list` | – | `models.list.result` |
| `chat.start` | `model`, `messages[{role: system\|user\|assistant, content}]` (1–1000), `params?{temperature, top_p, max_tokens, reasoning}` | `chat.ack`, `chat.status`*, `chat.delta`*, `chat.complete` |
| `chat.cancel` | `target` (chat id) | `chat.cancel.result` (and the stream ends with `finishReason: "cancelled"`) |
| `chat.resume` | `target`, `missing?[seq]` or `fromSeq?` | re-sent `chat.delta`s and `chat.complete` if finished |
| `pair.request` | `token?` (invite), `label?` | `pair.result {status: approved\|pending\|denied}` |
| `metrics.get` | `model?` (an exposed model), `host?` (bool) | `metrics.result` |

### System prompts

A conversation's system prompt travels inside `chat.start` as leading
`role: "system"` messages. There is no separate operation. Rules enforced by the worker:

* System messages may only come first. A system message after a user or
  assistant message, or a request with no user/assistant message, gets
  `invalid_request`.
* Their combined length must not exceed `limits.maxSystemPromptChars`, which
  `server.info.result` advertises. Otherwise the worker returns `too_large`.
* The text only goes to the model. It can't change access, exposed models,
  limits, provider settings or tools, and the client can't choose how the
  engine receives it. That choice belongs to the worker owner: a leading
  `system` or `developer` message, or text prepended to the first user message
  (see [worker.md](worker.md#system-prompts)).

## Worker → client

All carry `re`, the id of the request they answer.

| type | fields |
|---|---|
| `server.info.result` | `name`, `software`, `versions`, `streaming{batchMs, resume}`, `limits{maxRequestBytes, maxResponseChars, maxMessages, requestTimeoutSec, maxSystemPromptChars?, heartbeatSec?, inactivityTimeoutSec?, maxTokens?}` |
| `models.list.result` | `models[{id, contextLength?, streaming, cancel}]` (only models exposed to this user) |
| `chat.ack` | `model` |
| `chat.status` | `n` (increasing), `state` (loading\|prompt\|thinking\|answering\|finishing), `progress` (active\|quiet\|unknown), `elapsedMs`, `sinceProgressMs`, `deltaCount`, `reasoningTokens`, `answerTokens`, `tokensPerSecond` (nullable). On state changes (at most 1/s) and every `heartbeatSec`. |
| `chat.cancel.result` | `target`, `status` (cancelled\|finished\|not_found\|unconfirmed) |
| `chat.delta` | `seq` (0-based), `content?`, `reasoning?` |
| `chat.complete` | `deltaCount`, `finishReason` (stop\|length\|cancelled\|error\|timeout), `errorCode?`, `contentLength`, `usage?{promptTokens, completionTokens, reasoningTokens?, source?, tokensPerSecond?, firstTokenMs?, generationMs?}` |
| `metrics.result` | `at`, `provider`, `model` (ModelMetrics\|null), `engine` (EngineMetrics\|null), `host` (HostMetrics\|null), `monitoring{host, refreshSec}` |
| `server.error` | `code`, `message` (fixed, sanitized text), `retryAfter?`, `versions?` |
| `pair.result` | `status` |

Error codes: `unauthorized`, `pending_approval`, `rate_limited`, `busy`,
`invalid_request`, `unsupported_version`, `model_unavailable`,
`provider_unavailable`, `provider_error`, `timeout`, `too_large`, `not_found`,
`expired`, `internal`. Messages are fixed strings. Provider bodies, file paths
and stack traces are never forwarded.

Newer `usage` fields (`answerTokens`, `sources`, `maxTokens`, `contextWindow`,
`firstReasoningMs`, `firstAnswerMs`, `inferenceMs`, `detail`) sit inside `usage`
because clients ignore unknown fields there. See [reasoning.md](reasoning.md).

## Metrics

`metrics.get` is read-only and answered only to explicitly authorized users.
Unknown users, and anonymous users in public mode, get `unauthorized`. It has
its own rate budget (30/min), separate from chat. In every metrics object,
**`null` means unavailable**, never zero. `at` fields are Unix milliseconds of
when the value was read.

| Object | Fields |
|---|---|
| `ModelMetrics` | `id`, `at`, `state` (loaded\|not-loaded\|unknown), `maxContext` (the model's theoretical maximum), `loadedContext` (the window the engine actually allocated or configured), `memoryBytes`, `vramBytes`, `sizeBytes` (weights on disk), `architecture`, `quantization`, `parameters` |
| `EngineMetrics` | `at`, `kvCacheUsage` (0–1), `requestsRunning`, `requestsWaiting`. Only when the owner enables engine metrics (vLLM). |
| `HostMetrics` | `at`, `platform`, `memTotalBytes`, `memAvailableBytes`, `memUsedPercent`, `swapTotalBytes`, `swapUsedBytes`, `pressure` (normal\|warning\|critical). Only when requested **and** the owner enabled host monitoring. |

Token accounting: `chat.complete.usage.source` is `measured` when the engine
counted the tokens and `estimated` when the worker derived them from text length
(~4 characters per token). The worker times generation itself:
`firstTokenMs` runs from the engine request to the first token, and
`tokensPerSecond = completionTokens / generationMs`.

The client estimates the next request's context as the last measured
`promptTokens`, plus visible output (`completionTokens − reasoningTokens`),
plus text length for anything newer. It divides by `loadedContext`, never by
`maxContext`.

Clients poll `metrics.get` every `monitoring.refreshSec` seconds only while
their metrics panel is open. The worker never samples in the background, and it
reuses a host sample for half the interval.

## Fragments (transport level)

```json
{ "type": "frag", "fid": "<message id>", "i": 0, "n": 3, "sha256": "<hex of full text>", "data": "<slice>" }
```

## Example exchange

```
→ chat.start  {v:1,id:"Q3…",exp:…,replyTo:"9f…",model:"qwen/qwen3.5-9b",messages:[{role:"user",content:"Hi"}]}
← chat.ack    {re:"Q3…",model:"qwen/qwen3.5-9b"}
← chat.delta  {re:"Q3…",seq:0,reasoning:"The user greets…"}
← chat.delta  {re:"Q3…",seq:1,content:"Hello! How can I"}
← chat.delta  {re:"Q3…",seq:2,content:" help today?"}
← chat.complete {re:"Q3…",deltaCount:3,finishReason:"stop",contentLength:28}
```
