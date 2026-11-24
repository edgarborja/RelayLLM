import type { ErrorCode } from "./types.ts";

export class RelayLLMError extends Error {
  override name = "RelayLLMError";
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
