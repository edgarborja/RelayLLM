# Security model

## What is protected

| Property | Mechanism |
|---|---|
| Confidentiality from relays | NIP-44 v2 (ChaCha20 + HMAC-SHA256, padded) to the recipient's key |
| Sender authentication and integrity | Schnorr-signed inner event, verified after decryption; the outer wrap is also verified |
| Recipient binding | The inner event's `p` tag must equal the key it was received on, so a captured message can't be re-wrapped to another worker |
| Replay | Inner event ids are remembered for the freshness window (`created_at` within −180 s / +90 s). Events created before the worker started are rejected. Chat ids are de-duplicated. |
| Expiry | Application `exp`, plus NIP-40 `expiration` on the wrap |
| Authorization | Enforced on the worker for every request, using the cryptographic sender. Private mode (allowlist) is the default. |
| Resource limits | Per-user rate limits, global and per-user concurrency limits, request/response size caps, `max_tokens` cap, request timeout, bounded reassembly, a public-mode daily quota |

## What the worker refuses to do

The gateway is an inference gateway, not a proxy:

* The only provider HTTP calls are `GET {base}/models`, `POST {base}/chat/completions`, and the engine's read-only discovery endpoints (`/api/v0/models` for LM Studio; `/api/tags` and `/api/version` for Ollama).
* The provider base URL comes from local config only. By default it must be loopback. Redirects are refused.
* Requests are rebuilt from allowlisted fields: `model`, `messages[role, content]`, `temperature`, `top_p`, `max_tokens`. Tools, functions, `response_format`, extra roles and unknown fields are rejected by the schema.
* A model must be explicitly exposed (`relayllm models enable`).
* No shell, filesystem, model management, MCP, or agent features exist in the code.

## Metadata visible to relays

Relays (and anyone watching them) can see:

* **Recipient pubkeys.** Requests are tagged with the worker's npub, and responses with the client's per-session key. A relay can therefore tell that *some* sessions talk to this worker, but it doesn't learn your long-term identity from tags.
* **Timing and sizes.** When you chat, roughly how long answers are (NIP-44 padding hides exact sizes), and the event rate during streaming (~4 events/s).
* **Your IP address**, as the WebSocket client of the relay. Likewise the worker machine's IP. Use a VPN or Tor at the network layer if that matters to you.
* **NIP-42 AUTH.** The worker authenticates with its own key; the client uses its session key.

Relays cannot see prompts, responses, model names, your identity, or the worker's configuration.

## Keys and secrets

* **Worker key:** stored in the macOS Keychain, or in an owner-only `0600` file under `~/.relayllm/secrets` (Linux, or by choice). It is never logged or published. Rotating it (`relayllm identity rotate`) changes the npub, so every device must be paired again; the old key is deleted.
* **Provider API key:** stored in the same secret store and sent only to the configured loopback endpoint.
* **Browser identity:** stored as a NIP-49 `ncryptsec` (scrypt with N=2^16, then XChaCha20-Poly1305) under your password. NIP-07 users keep the key in their extension. Private keys never appear in URLs.
* **Pairing links** contain only the worker npub, relays, display name, and an optional single-use invite. The invite is in the URL fragment, so it isn't sent to the static host. It expires (24 h by default) and only a SHA-256 hash is stored on the worker.

## Browser storage threat model

Conversations and the worker list are encrypted in IndexedDB with AES-256-GCM, bound to their record id. The key is a random data key, stored NIP-44-encrypted to your own pubkey, and only an unlocked identity can recover it.

Protected against: someone copying the browser profile while the app is locked; other identities using the same browser.

Not protected against: malware or a malicious extension running while the app is unlocked; a compromised static host serving modified JavaScript (pin your own deployment); someone who knows your vault password and has the profile. Timestamps and record counts are not encrypted. Clearing site data deletes everything, and nothing is backed up anywhere.

## Rendering untrusted model output

Markdown is rendered without raw HTML. Links are sanitized and open with `noopener noreferrer`. Images are **not loaded**: they show as links, because a prompt-injected reply could otherwise exfiltrate conversation text through an image URL. A strict Content-Security-Policy blocks inline and remote scripts and remote images, and limits network access to WebSocket relays.

## Residual risks and limitations

* **Unauthorized traffic still costs work.** Anyone can send events tagged to the worker. Each costs one signature check, one ECDH, and one decryption before authorization. Relays' own rate limits are the main defense against floods.
* **Access requests can be spammed.** The pending list holds at most 50 entries, and new requests push out the oldest. Prefer invite links.
* **The replay cache is bounded** at 100k ids. A flood large enough to evict ids within the 4.5-minute window could re-enable replay of an evicted request. The `chat.start` id de-duplication still prevents running a duplicate concurrent stream.
* **Clock skew** beyond about 90 s makes the worker silently drop requests.
* **Public mode** lets anyone use your GPU within the configured quotas. Only enable it deliberately.
* **The relay operator** can drop, delay, or reorder events (denial of service). They cannot forge or read them.
* **Forward secrecy:** NIP-44 has none. If an attacker records relay traffic and the worker key leaks later, they can decrypt the requests sent to the worker. Requests include the conversation context, so that typically means earlier answers too. Responses alone are encrypted to short-lived session keys. Rotate the worker key if you suspect a compromise.
* This code has not had an independent security audit.
