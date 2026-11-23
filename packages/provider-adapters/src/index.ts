import {
  LMStudioProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  VLLMProvider,
  type OpenAICompatibleOptions,
} from "./openai-compatible.ts";
import type { ProviderAdapter, ProviderKind } from "./types.ts";

export * from "./types.ts";
export * from "./endpoint-policy.ts";
export * from "./openai-compatible.ts";
export { readSse } from "./sse.ts";

export const PROVIDER_DEFAULTS: Record<ProviderKind, { label: string; baseUrls: string[] }> = {
  lmstudio: {
    label: "LM Studio / Bionic",
    baseUrls: ["http://localhost:1234/v1", "http://localhost:1235/v1"],
  },
  ollama: { label: "Ollama", baseUrls: ["http://localhost:11434/v1"] },
  vllm: { label: "vLLM", baseUrls: ["http://localhost:8000/v1"] },
  "openai-compatible": { label: "Other OpenAI-compatible server", baseUrls: [] },
};

export function createProvider(kind: ProviderKind, opts: OpenAICompatibleOptions): ProviderAdapter {
  switch (kind) {
    case "lmstudio":
      return new LMStudioProvider(opts);
    case "ollama":
      return new OllamaProvider(opts);
    case "vllm":
      return new VLLMProvider(opts);
    case "openai-compatible":
      return new OpenAICompatibleProvider(opts);
  }
}
