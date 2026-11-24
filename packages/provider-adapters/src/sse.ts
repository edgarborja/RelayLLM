/** Read newline-delimited text from a body, with a line length bound and prompt abort. */
export async function* readLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal, maxLine = 1_000_000): AsyncGenerator<string> {
  const reader = body.getReader();
  // Don't rely on fetch alone to tear down the body: cancel the reader
  // explicitly so the engine sees the connection close and stops generating.
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new Error("aborted");
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
      }
      if (buf.length > maxLine) throw new Error("line too long");
    }
    finished = true;
    if (buf) yield buf;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Minimal Server-Sent Events parser for OpenAI-style streams.
 * Yields the `data:` payload of each event; comments (keep-alives) and other
 * fields are ignored.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal, maxLine?: number): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of readLines(body, signal, maxLine)) {
    if (line === "") {
      if (data.length) yield data.join("\n");
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length) yield data.join("\n");
}
