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
| `chat.start` | `model`, `messages[{role: system\|user\|assistant, content}]` (1–1000), `params?{temperature, top_p, max_tokens}` | `chat.ack`, `chat.delta`*, `chat.complete` |
| `chat.cancel` | `target` (chat id) | (the stream ends with `finishReason: "cancelled"`) |
| `chat.resume` | `target`, `missing?[seq]` or `fromSeq?` | re-sent `chat.delta`s and `chat.complete` if finished |
| `pair.request` | `token?` (invite), `label?` | `pair.result {status: approved\|pending\|denied}` |

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
| `server.info.result` | `name`, `software`, `versions`, `streaming{batchMs, resume}`, `limits{maxRequestBytes, maxResponseChars, maxMessages, requestTimeoutSec, maxSystemPromptChars?}` |
| `models.list.result` | `models[{id, contextLength?, streaming, cancel}]` (only models exposed to this user) |
| `chat.ack` | `model` |
| `chat.delta` | `seq` (0-based), `content?`, `reasoning?` |
| `chat.complete` | `deltaCount`, `finishReason` (stop\|length\|cancelled\|error\|timeout), `errorCode?`, `contentLength`, `usage?{promptTokens, completionTokens}` |
| `server.error` | `code`, `message` (fixed, sanitized text), `retryAfter?`, `versions?` |
| `pair.result` | `status` |

Error codes: `unauthorized`, `pending_approval`, `rate_limited`, `busy`,
`invalid_request`, `unsupported_version`, `model_unavailable`,
`provider_unavailable`, `provider_error`, `timeout`, `too_large`, `not_found`,
`expired`, `internal`. Messages are fixed strings. Provider bodies, file paths
and stack traces are never forwarded.

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
