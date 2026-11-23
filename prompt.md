# RelayLLM — Project Specification and Implementation Instructions

## 1. Project overview

Build **RelayLLM**, an open-source, self-hosted AI gateway that allows users to securely access private, locally hosted LLMs from anywhere using Nostr as the communication transport.

The goal is to provide a ChatGPT/Claude-like experience without requiring:

- Port forwarding or NAT configuration.
- A public IP address or domain for the AI server.
- A VPN, reverse proxy, or cloud-hosted application backend.
- Installation of software on the client device.
- Third-party hosting of the AI inference engine.

The system will consist of two main components:

1. **RelayLLM Client:** A fully static web application deployable on GitHub Pages or any static web host.
2. **RelayLLM Worker:** A lightweight local service that connects private AI inference engines to Nostr relays.

The browser client and worker communicate exclusively through encrypted Nostr messages.

Public Nostr relays provide message transport, but must not have access to the plaintext conversations or private keys. AI inference occurs on the worker's machine.

The first development environment is an Apple Silicon Mac Mini running macOS and LM Studio Bionic. However, the implementation must be platform-independent and support other local AI engines.

**Primary product principle: Install the worker, obtain its npub, open the client, and chat with your private AI from anywhere.**

Keep the project lightweight, modular, secure, and easy to install.

---

## 2. Research existing implementations first

Before implementing the Nostr communication layer, examine the following existing projects:

- ContextVM: https://contextvm.org/
- ContextVM muxll: https://github.com/ContextVM/muxll
- Nostr Data Vending Machines (NIP-90): https://nips.nostr.com/90
- NIP-44 encryption: https://nips.nostr.com/44
- NIP-17 private messaging: https://nips.nostr.com/17

Determine whether ContextVM or another existing library can provide the required encrypted, bidirectional, streaming communication.

Prefer established libraries and protocol conventions where practical.

Avoid creating a new transport protocol if an existing solution adequately meets the requirements.

However, do not introduce unnecessary infrastructure or complexity merely to reuse an existing framework.

Document the selected transport architecture and the reasoning behind it.

In particular, evaluate NIP-44 encryption, NIP-17/NIP-59 gift wrapping, and the suitability of ContextVM streaming for interactive LLM conversations. NIP-90 interoperability is desirable but not mandatory for the MVP.

---

## 3. Component A: RelayLLM Worker

### Purpose

The worker runs alongside an existing AI inference engine and makes selected inference capabilities accessible through Nostr.

It must not require modifications to the underlying AI software.

### 3.1 Supported AI providers

Implement a provider abstraction supporting OpenAI-compatible APIs.

The initial implementation must support:

- LM Studio / Bionic
- Ollama
- vLLM
- Other OpenAI-compatible HTTP endpoints

Support provider-specific adapters when necessary, but prefer a common interface.

The worker should support:

- Configurable API endpoint and authentication.
- Automatic model discovery where supported.
- Manually configured model names when discovery is unavailable.
- Explicit selection of models exposed to remote clients.
- Text chat completions.
- Streaming chat responses.
- Request cancellation.
- Provider health checks.

Architect the adapter layer so future support for the Responses API, multimodal models, embeddings, and other inference capabilities can be added without changing the Nostr transport.

The first version should prioritize chat completions.

**Do not expose arbitrary local API endpoints.** The worker must implement an explicit allowlist of permitted operations.

### 3.2 Nostr identity

On first execution, the worker should:

1. Generate a unique Nostr keypair using a cryptographically secure random generator, unless an identity is imported.
2. Store its private key securely on the local machine.
3. Display its public npub.
4. Connect to a configurable set of Nostr relays.
5. Generate a QR code and shareable client URL containing the worker's npub and relay connection information.

The worker's private key must never be shared with the client or published.

Use OS-protected credential storage where practical. Never include private keys or provider credentials in logs.

The worker should reconnect automatically following network interruptions.

### 3.3 Access control

Implement two configurable authorization modes:

**Private mode (default):**

Only users whose Nostr public keys are explicitly allowed can communicate with the worker.

**Public mode (optional, explicitly enabled):**

Any user may submit inference requests, subject to configurable rate limits, quotas, and concurrency restrictions.

Private mode must be the default.

The worker should support:

- Adding and removing authorized user npubs.
- A configurable maximum number of concurrent inference requests.
- Per-user rate limits.
- Request timeouts.
- Maximum request and response sizes.
- Maximum context/token budgets where supported.
- Replay protection.
- Request cancellation.
- Optional per-user model restrictions in a later version.

Authorization must be enforced on the worker, not merely in the browser client.

Validate cryptographic identities rather than trusting client-supplied user identifiers.

Do not reveal the model catalog, configuration, internal errors, or other private information to unauthorized users.

### 3.4 Pairing

Provide a simple pairing process.

A user opening the client should be able to add a worker by entering its npub or opening a pairing URL.

If the user's npub is not authorized, the client should indicate that access approval is required without exposing private worker information.

The worker owner should be able to approve a user through a local interface or CLI.

A pairing QR/link may include the worker npub, relay URLs, and a short-lived, single-use authorization invitation token. Such tokens must be independently validated by the worker, expire, and never contain long-lived private credentials.

### 3.5 Local administration

For the MVP, provide a CLI and configuration file with commands to:

- Initialize the worker.
- Select/configure an AI provider.
- List discovered models.
- Enable or disable individual models.
- Display the worker npub and pairing URL.
- Add or remove authorized user npubs.
- Configure Nostr relays.
- Start the worker.
- View connection and health status.
- Rotate worker credentials with documented recovery implications.

A graphical menu-bar application is not required initially.

The worker should eventually be packageable as a macOS background service and as a Linux systemd service.

### 3.6 Security boundary

**This is a critical requirement.**

The worker is an AI inference gateway, not a remote administration service.

It must never expose:

- Arbitrary shell or command execution.
- Filesystem access.
- Local network scanning.
- Arbitrary HTTP requests.
- Provider administration endpoints.
- Model installation or deletion operations.
- Host configuration or system control.
- Bionic's agent tools or filesystem capabilities.

Do not enable function calling, MCP tools, code execution, or filesystem-capable agent features in the MVP.

Forward only explicitly supported inference operations.

Restrict provider connections to explicitly configured endpoints. Default to loopback connections and prevent users from choosing arbitrary destinations through chat requests.

Keep API credentials server-side.

Treat prompts, model responses, and incoming Nostr messages as untrusted input.

---

## 4. Component B: RelayLLM Client

### Purpose

Build a fully static single-page application providing an intuitive chat experience comparable to ChatGPT, Claude, or Gemini.

The application must work when hosted on GitHub Pages, without a custom backend.

### 4.1 Technology

Use a modern TypeScript frontend framework, preferably React with Vite, unless a simpler implementation offers clear advantages.

Requirements:

- Static production build.
- No server-side rendering requirements.
- No backend API controlled by RelayLLM.
- Browser-based Nostr WebSocket communication.
- Responsive desktop and mobile UI.
- Local browser persistence.
- Dark and light themes.

### 4.2 Authentication and identity

Each user must have a Nostr identity.

Support two authentication methods:

1. **External Nostr signer:** Prefer NIP-07-compatible browser signers, where available.
2. **Local browser identity:** Generate or import a Nostr keypair, protected with an encrypted local vault.

Never place private keys in URL parameters.

Do not persist plaintext nsecs in localStorage.

Use authenticated encryption and appropriate password-based key derivation for locally stored identities.

Handle incorrect passwords, locked vaults, and unavailable signers gracefully.

### 4.3 Connecting to a worker

Allow users to add one or more RelayLLM workers.

A worker can be configured through:

- Manual npub entry.
- QR code.
- Shareable URL containing the worker npub and Nostr relay information.
- A saved worker profile.

For example:

`https://example.github.io/relayllm/?worker=npub1...&relay=wss%3A%2F%2Frelay.example`

The URL must never contain an nsec, provider API key, or other long-lived secret.

Worker identities and relay lists are not inherently confidential. Treat URL parameters as untrusted input and validate them.

Support switching between configured workers.

Workers should have friendly local display names.

### 4.4 Chat interface

Implement a polished, minimalist chat interface with:

- Sidebar showing conversation history.
- New conversation.
- Conversation rename and delete.
- Worker selector.
- Model selector displaying models authorized for the current user.
- Chat input with multiline support.
- Streaming assistant responses.
- Markdown rendering.
- Syntax-highlighted code blocks.
- Copy message and copy code actions.
- Stop generation button.
- Retry or regenerate response.
- Conversation persistence.
- Connection status indication.
- Responsive layout.

The interface should be visually comparable in quality to modern AI chat applications without attempting to reproduce proprietary branding or assets.

Avoid unnecessary UI complexity.

### 4.5 Local conversation storage

Store conversation history locally in the browser using IndexedDB.

No application server should store conversation history by default.

Persist:

- Conversations.
- Message content.
- Selected worker and model.
- Conversation titles.
- Timestamps.
- Non-secret user preferences.

Provide an option to delete local conversation history.

Encrypt stored conversation content at rest when practical, using a key protected by the local identity vault, and clearly document the browser-storage threat model.

### 4.6 Multi-worker and multi-model support

A client should be able to connect to multiple independent workers.

For example:

- Home Mac Mini — Bionic.
- Office GPU server — Ollama.
- Private company server — vLLM.

Each worker may advertise multiple models.

The user should be able to switch workers or select a model from the available models.

For the MVP, an individual conversation is associated with one worker and one model. Switching workers or models may start a new conversation or explicitly continue an existing one by sending its context.

---

## 5. Communication protocol

All remote inference traffic must travel through Nostr relays.

Neither the client nor the worker should require direct network connectivity to the other.

### 5.1 Security

Use authenticated end-to-end encryption.

Prefer established Nostr encryption primitives such as NIP-44, combined with an appropriate signed-event and metadata-protection scheme.

The protocol must provide:

- Sender authentication.
- Message integrity.
- Recipient confidentiality.
- Request correlation.
- Replay prevention.
- Message expiration.
- Worker-side authorization.
- Protocol version negotiation.

Do not invent custom cryptographic primitives.

Be explicit about metadata exposed to Nostr relays, including event sizes, timing, and any visible recipient identifiers.

### 5.2 Supported operations

Define a small versioned application protocol supporting at least:

| Operation | Purpose |
|---|---|
| `server.info` | Retrieve authorized server capabilities |
| `models.list` | Retrieve available authorized models |
| `chat.start` | Begin inference |
| `chat.delta` | Stream generated response chunks |
| `chat.complete` | Mark response completion |
| `chat.cancel` | Cancel an active request |
| `server.error` | Return sanitized errors |

Each operation must include the necessary identifiers for correlating requests, responses, sessions, and chunks.

Document message schemas and provide validation for incoming data.

Avoid introducing a large generic RPC framework unnecessarily.

### 5.3 Streaming

Streaming is a first-class requirement.

Do not require clients to wait until the entire inference response is generated.

However, avoid publishing a Nostr event for every generated token.

Implement configurable batching based on elapsed time or generated text size.

Suggested initial targets:

- Batch responses approximately every 250 ms, subject to relay performance.
- Include sequence numbers for reassembly.
- Handle duplicated events.
- Handle out-of-order events.
- Detect missing chunks.
- Support cancellation.
- Handle reconnects and expired requests.

Treat these as starting parameters, not guaranteed relay performance.

Implement buffering and backpressure to avoid excessive memory usage and relay flooding.

Clearly indicate when relay limitations prevent truly smooth token streaming.

### 5.4 Conversation context

In the MVP, the browser owns conversation history.

For each chat request, the client sends the conversation messages needed to construct the current model context.

The worker forwards the authorized request to the selected model.

Avoid requiring long-lived server-side chat sessions.

Apply configurable context-length and payload-size limits.

Account for relay event-size limits; do not assume arbitrary-size prompts can be sent as one Nostr event.

If larger context requires chunking, implement bounded chunk transfer with integrity checking and expiration.

Do not silently truncate conversations without informing the user.

---

## 6. Local provider integration

Create a clean interface between the Nostr gateway and inference providers.

Suggested architecture:

`Nostr Transport → Authentication → Request Router → Provider Adapter → Local AI API`

Provider adapters must expose consistent operations for:

- Discovery.
- Model listing.
- Chat completion.
- Streaming.
- Cancellation.
- Health checks.

Where provider behavior differs, document limitations and implement graceful fallbacks.

### Initial test provider: LM Studio Bionic

The first real integration test should use the OpenAI-compatible local API made available by LM Studio Bionic on macOS.

Do not assume a fixed local port. Make the endpoint configurable and provide sensible defaults.

Verify the actual API features available before implementing provider-specific functionality.

If a provider does not support streaming or cancellation, the client should continue functioning with reduced capabilities and clearly identify those limitations.

---

## 7. Repository organization

Create one repository containing the two applications and any shared code.

Suggested structure:

```text
relayllm/
  apps/
    client/
    worker/
  packages/
    protocol/
    provider-adapters/
    nostr-transport/
  docs/
  examples/
  README.md
```

Shared packages should contain:

- Typed message schemas.
- Protocol validation.
- Nostr communication helpers.
- Encryption and signing integration.
- Provider interfaces.
- Common error definitions.

Use a TypeScript monorepo unless there is a compelling technical reason to choose otherwise.

Avoid excessive abstraction or unnecessary dependencies.

---

## 8. Security requirements

Before considering the MVP complete:

- No worker private keys in the public repository.
- No client private keys in URLs or plaintext persistent storage.
- No arbitrary HTTP proxy functionality.
- No remote shell or filesystem access.
- No unrestricted model or provider administration.
- Authorization checked for every request.
- Event signatures and authenticated identities verified.
- Replay and duplicate request protection.
- Request expiration and timeouts.
- Rate limiting and bounded resource consumption.
- Sanitized errors.
- Prompt and response contents excluded from ordinary logs.
- API keys protected locally.
- Safe Markdown rendering without executable HTML or scripts.
- No telemetry or analytics by default.
- No dependency on a RelayLLM-operated account service.

Document security limitations and residual risks.

---

## 9. User experience and installation

The ideal worker setup should be:

```bash
relayllm init
relayllm start
```

The initialization flow should guide users through:

1. Selecting their AI provider.
2. Finding the provider's local endpoint.
3. Discovering available models.
4. Selecting models to expose.
5. Generating or importing the worker Nostr identity.
6. Choosing Nostr relays.
7. Configuring private access.
8. Displaying a pairing URL and QR code.

The worker should save its configuration locally so subsequent launches do not require repeating setup.

For the browser client:

1. Open the static website.
2. Create or unlock a Nostr identity.
3. Add a worker through an npub or pairing URL.
4. Receive authorization if required.
5. Select an available model.
6. Begin chatting.

Make installation instructions understandable to users who are comfortable running local AI software but do not have networking or Nostr development expertise.

---

## 10. Testing and acceptance criteria

Create automated unit and integration tests.

Use a mock OpenAI-compatible provider to test the complete protocol without requiring a GPU.

Include tests for:

- Worker initialization.
- Provider model discovery.
- Authorized requests.
- Rejected unauthorized requests.
- Spoofed identities.
- Invalid event signatures.
- Expired and replayed messages.
- Encrypted message exchange.
- Streaming chunk ordering and duplication.
- Request cancellation.
- Relay disconnections and reconnections.
- Provider timeouts and errors.
- Multiple workers and models.
- Browser conversation persistence.
- Denied attempts to access arbitrary local endpoints.

Provide a local development setup using a test Nostr relay.

**End-to-end acceptance test:**

1. Start the worker on macOS.
2. Connect it to a running Bionic local API.
3. Connect the worker to public Nostr relays.
4. Open the static client on a different device and network.
5. Add the worker using its npub and relay information.
6. Authenticate with an authorized user npub.
7. Retrieve the available models.
8. Send a chat message.
9. Receive the generated response progressively.
10. Cancel a request and verify generation stops where supported.
11. Verify that an unauthorized user cannot query the worker.
12. Confirm that the worker requires no inbound firewall rules or port forwarding.

The final deliverable should include deployment documentation for GitHub Pages.

---

## 11. MVP scope and exclusions

Prioritize:

- Reliable private connectivity.
- Secure identities and authorization.
- OpenAI-compatible provider support.
- Model discovery.
- Streaming chat.
- Local chat history.
- A high-quality responsive client.
- Straightforward installation.

Do not implement initially:

- Payments or Lightning integration.
- Public model marketplaces.
- RAG or document ingestion.
- Image generation.
- Voice conversations.
- Agent tools.
- MCP execution.
- Multiuser organizational administration.
- Cloud synchronization.
- Remote model installation.
- Remote machine administration.

Keep the architecture extensible, but do not implement speculative functionality.

---

## 12. Development instructions

Work in the following sequence:

**Phase 1 — Architecture and research**

Examine relevant existing libraries and projects. Choose the simplest secure transport architecture and document it briefly.

**Phase 2 — Protocol and mock provider**

Implement message schemas, identities, encryption, request/response correlation, and a mock inference provider.

**Phase 3 — Working end-to-end prototype**

Build a minimal browser client and worker demonstrating encrypted Nostr requests and responses.

**Phase 4 — Provider integration**

Implement OpenAI-compatible APIs, model discovery, and Bionic integration. Add Ollama compatibility and verify the adapter design works with other providers.

**Phase 5 — Streaming and reliability**

Implement progressive responses, cancellation, reconnection handling, and event reassembly.

**Phase 6 — Complete client**

Build the responsive chat interface, conversation management, local storage, and multi-worker support.

**Phase 7 — Security and deployment**

Complete authorization testing, hardening, documentation, and static deployment.

At every phase:

- Produce running, testable code.
- Run available tests.
- Fix errors before proceeding.
- Prefer simple, maintainable solutions.
- Avoid overengineering.
- Document significant architectural decisions.
- Do not replace implementation work with lengthy theoretical descriptions.

**The objective is a usable RelayLLM MVP, not merely a design document.**

Success means I can run Bionic on my Mac Mini, install RelayLLM Worker alongside it, and securely use its models through a static RelayLLM website from another network—without VPNs, cloud inference servers, NAT configuration, or direct access to my Mac.

During testing you can use this instance of Bionic: http://localhost:1235/v1 and this nostr relay server: relay.k1.sv