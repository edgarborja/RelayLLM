// Public types. Keep this file free of imports and runtime code: the build
// ships it unchanged as the package's type declarations.

export type Reasoning = "off" | "on" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Worker codes (busy, rate_limited, unauthorized, …) plus the client's own:
 * no_response, publish_failed, incomplete, truncated, invalid_output,
 * invalid_schema, unsupported, cancelled, no_profile.
 */
export type ErrorCode = string;

export interface RunRequest {
  /** Text sent as the user message. Every run is a fresh conversation. */
  input: string;
  /** Returned on the result; defaults to a random id. */
  id?: string;
  /** Optional when the worker offers exactly one model. */
  model?: string;
  /** System prompt. */
  system?: string;
  /** JSON Schema for the output. The result's `output` is then the parsed, validated value. */
  schema?: Record<string, unknown>;
  /** Always off with a schema (for models that can switch it off). Default: the model's own. */
  reasoning?: Reasoning;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with the partial text while it streams. */
  onText?: (text: string) => void;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  tokensPerSecond?: number;
}

export interface RunSuccess<T = unknown> {
  id: string;
  ok: true;
  model: string;
  /** Parsed JSON with a schema, otherwise the answer text. */
  output: T;
  finish: "stop";
  usage?: Usage;
  attempts: number;
  ms: number;
}

export interface RunFailure {
  id: string;
  ok: false;
  model: string;
  error: { code: ErrorCode; message: string };
  /** Whatever text arrived before the failure. */
  text?: string;
  usage?: Usage;
  attempts: number;
  ms: number;
}

export type RunResult<T = unknown> = RunSuccess<T> | RunFailure;

export interface Model {
  id: string;
  contextLength?: number;
  reasoningOptions: Reasoning[];
}

export interface RelayLLM {
  readonly workerName: string;
  readonly models: Model[];
  /** True if this worker can enforce a JSON schema. */
  readonly structuredOutput: boolean;
  /**
   * Run one request. Runs on a connection are queued and sent one at a time.
   * Request failures are returned (ok: false), not thrown; RelayLLMError is
   * thrown only for an unusable request, such as an invalid schema.
   */
  run<T = unknown>(req: RunRequest): Promise<RunResult<T>>;
  close(): void;
}

export interface ConnectOptions {
  /** Profile created by `relayllm-api pair`. Default: "default". */
  profile?: string;
  /** Or connect without a profile file: all three together. */
  worker?: string;
  relays?: string[];
  /** nsec or 64-character hex. */
  secretKey?: string;
  /** How long a run keeps waiting on a busy or rate-limited worker. Default: 600000. */
  maxWaitMs?: number;
  /** Wait for the worker's first answer. Default: 15000. */
  requestTimeoutMs?: number;
}

export type Connect = (options?: ConnectOptions) => Promise<RelayLLM>;
