# Using RelayLLM from programs

`relayllm-api` is a command and a Node library (22+) that call a worker over the same encrypted Nostr protocol as the chat client. It talks to the same worker npub, and the worker opens no ports.

## Set up

```bash
./scripts/install-api.sh                        # on the machine that makes the calls
relayllm pair --invite --label letters          # on the worker: prints a pairing link
relayllm-api pair '<pairing link>'              # creates this program's identity
relayllm-api status
```

Give programs their own identity rather than your chat identity: the worker runs one request per user at a time (`limits.perUserConcurrent`), so a batch would block your own chat. You can also revoke it separately. The key is stored in `~/.relayllm-api/<profile>.json` (mode 0600, unencrypted, so that scripts can run unattended).

## Command line

```bash
relayllm-api run "Buenos días" --system "Translate to English." --reasoning off
relayllm-api batch letters/*.txt --system translate.md --schema letter.json --out results.jsonl
```

`batch` takes text files (one item each; the id is the file name) or `.jsonl` files with one `{"id": "…", "input": "…"}` per line. It sends them one at a time, each as a fresh conversation, and writes one JSON result per line:

```json
{"id":"1.txt","ok":true,"model":"qwen/qwen3.5-9b","output":{"translation":"…"},"finish":"stop","usage":{"promptTokens":50,"completionTokens":57},"attempts":1,"ms":2306,"key":"9568a70aaafe5fb7"}
{"id":"2.txt","ok":false,"model":"qwen/qwen3.5-9b","error":{"code":"truncated","message":"…"},"text":"…","attempts":1,"ms":90211,"key":"…"}
```

With `--out`, rerunning the same command skips finished items and repeats failed ones. If a finished item's text or the settings changed (`key`), it refuses to continue; choose another file. A batch stops early if the worker is unreachable or refuses access. Exit codes: 0 all succeeded, 1 something failed, 2 wrong usage.

## Library

```bash
cd apps/api && pnpm build && npm pack           # then, in your project:
npm install /path/to/relayllm-api-0.1.0.tgz
```

```js
import { connect } from "@relayllm/api";

const llm = await connect();                    // or { profile }, or { worker, relays, secretKey }
const schema = {
  type: "object",
  properties: { translation: { type: "string" }, source_language: { type: "string" } },
  required: ["translation", "source_language"],
  additionalProperties: false,
};
for (const letter of letters) {
  const r = await llm.run({ system: "Translate the letter to English.", input: letter, schema });
  if (r.ok) console.log(r.output.translation);
  else console.error(r.error.code, r.error.message);
}
llm.close();
```

`run` returns failures as `ok: false`; it throws `RelayLLMError` only for an unusable request (for example an invalid schema). Runs on one connection are queued. `signal` cancels, `onText` streams.

## Structured output

With a schema, the worker has the engine constrain the answer (`response_format`; `format` on Ollama), and the client parses and validates it, retrying once if it doesn't match. Reasoning is switched off for models that allow it: with it on, Bionic was observed to put the JSON in the reasoning text and leave the answer empty.

The schema guarantees the shape of the answer, not that its content is right. Schemas are limited in size (`limits.maxSchemaChars`, default 16000; 0 disables the feature), nesting, and repetition, and may only reference themselves.

## Retries

| Situation | Behaviour |
|---|---|
| `busy`, `rate_limited` | Waits as long as the worker asks, up to 10 minutes in total (`maxWaitMs`) |
| No response, relay failure, engine unavailable, text lost in transit | Up to 3 attempts |
| `invalid_output` | 2 attempts |
| `truncated`, `timeout`, `unauthorized`, … | Not retried |

A retried request is generated again. The worker has to be online: messages expire after about two minutes and nothing is queued on relays.
