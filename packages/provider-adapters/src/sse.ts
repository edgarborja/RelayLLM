/**
 * Minimal Server-Sent Events parser for OpenAI-style streams.
 * Yields the `data:` payload of each event. Enforces a line length bound.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  maxLine = 1_000_000,
): AsyncGenerator<string> {
  const reader = body.getReader();
  // Don't rely on fetch alone to tear down the body: cancel the reader
  // explicitly so the engine sees the connection close and stops generating.
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new Error("aborted");
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        // ignore comments (":"), event:, id:, retry:
      }
      if (buf.length > maxLine) throw new Error("SSE line too long");
    }
    if (data.length) yield data.join("\n");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
