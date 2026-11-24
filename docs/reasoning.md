# Reasoning, timeouts, cancellation and live statistics

## What was cutting responses short

Found by tracing a request end to end (client → Nostr → worker → engine) and probing Bionic with Qwen 3.5 9B. Not every failure was a timeout.

| Layer | Limit before | Finding |
|---|---|---|
| Worker, inference | 300 s for the whole request, progress or not | **Cause.** Killed healthy reasoning. |
| Provider HTTP | Node's `fetch`: 300 s without headers, 300 s without body data | **Hidden cause.** Measured: both fail at 301 s (`UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`), so raising the worker's limit alone wouldn't have helped engines that stay silent. |
| Client | 330 s per response | **Cause**, once the worker allows longer. |
| Generation budget | `max_tokens` 8192, reasoning included | **Cause.** At ~28 tokens/s, 8192 tokens take about 293 s, so this and the 300 s limit hit at about the same moment. The client only said "maximum length", even with no answer at all. |
| Context window | Engine's loaded window | Overflow came back as an SSE error event and was shown as a generic engine error. |
| Stream end | – | A dropped engine connection was reported as a finished answer. |
| Response size | 200,000 characters, reasoning included | Not reached in practice; reported as a token limit if it was. |
| Nostr delivery | 15 s to first acknowledgement, 120 s message lifetime | Not a cause. |
| Relay message size | Fragmented above 32 KB | Not a cause. Deltas are at most 4000 characters. |
| Lost chunks | 8 recovery attempts per response | Would run out after a long disconnection. |
| Cancellation | Sent once, never acknowledged | A lost message left the engine running. |

The engine-side logs kept before this change don't record a duration or cause, so past individual failures can't be attributed with certainty. `chat finished` log lines now include both.

## Timeouts

| Control | Default | Enforced by |
|---|---|---|
| Heartbeat (`chat.status`) | 10 s while a request is active | Worker |
| Inactivity | 120 s without new text, **once text has started** | Worker |
| Absolute | 30 min | Worker, even with no client connected |
| Lost contact | 180 s of worker silence while relays are connected | Client |

`relayllm limits --absolute 3600 --inactivity 180 --heartbeat 10 --max-tokens 24000` changes them.

* Only reasoning or answer text counts as progress. Heartbeats and HTTP keep-alives don't.
* Before any text, an engine may be loading, reading the prompt, or reasoning without exposing it. That is reported as `progress: "unknown"`, not a stall, and only the absolute timeout applies. Bionic's `/v1` sends nothing during prompt processing, for example.
* The client shows relay connectivity, worker heartbeat and inference progress as separate things.
* Configs that spell out the old defaults (300 s, 8192 tokens) are raised once to 1800 s and 16,384. Other values are kept.

## Reasoning control

Off / Auto / On (and effort levels where offered), per conversation, under **Advanced settings** or the sliders button. Auto sends nothing. The worker advertises each model's options and refuses others.

| Engine | Options come from | Sent as | Reasoning text |
|---|---|---|---|
| LM Studio / Bionic | `/api/v1/models` capabilities | `reasoning_effort` (Off = `none`) | `reasoning_content` |
| Ollama | `/api/show` capabilities | native `think` on `/api/chat` | `thinking` |
| vLLM | owner: `relayllm models reasoning <id> toggle\|effort` | `chat_template_kwargs.enable_thinking` or `reasoning_effort` | `reasoning_content` / `reasoning` |
| Other | owner, as for vLLM | as for vLLM | as reported |

Bionic's native `/api/v1/chat` was evaluated. It adds prompt-processing progress, but keeps conversation state in the engine instead of taking assistant history, and can enable MCP integrations, so inference stays on `/v1`. On `/v1`, Bionic ignores `chat_template_kwargs` and `enable_thinking`; only `reasoning_effort` works.

A leading `<think>…</think>` block in answer text is moved to the reasoning stream. Hidden reasoning is never reconstructed: its token count is shown as unavailable.

## Cancellation

Stop freezes the visible text immediately, then sends `chat.cancel` (up to 3 attempts) until the worker answers `chat.cancel.result`. The worker aborts the engine request, waits up to 3 s for it to unwind, and frees the slot. If no confirmation arrives, the reply says so. A cancel only affects the sender's own request, can be repeated, and wins even if it overtakes the request. Reloading the page stops the request it left behind.

## Budgets and accounting

* `max_tokens` covers reasoning and answer together, and is reduced to what fits beside the prompt when the loaded window is known.
* A reply that ends early says why: `token_budget`, `context_full`, `engine_limit`, `response_size`, `inactivity`, `absolute_timeout`, `stream_ended`, `worker_shutdown`. Nothing is continued automatically.
* Each count carries its source (`provider`, `estimated`; absent = unavailable). Reasoning included in the engine's total is not counted twice.
* Inference durations come from the worker's monotonic clock; acknowledgement and end-to-end times from the client's. The two clocks are never subtracted.
