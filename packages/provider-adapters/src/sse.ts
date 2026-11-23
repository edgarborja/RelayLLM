/**
 * Minimal Server-Sent Events parser for OpenAI-style streams.
 * Yields the `data:` payload of each event. Enforces a line length bound.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, maxLine = 1_000_000): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
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
    reader.releaseLock();
  }
}
