/** Buffer only bounded API responses, keeping the deadline through body reads.
 * Not for media downloads. The returned response no longer holds a live stream.
 */
export async function boundedFetch(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
  maxBytes = 1_048_576,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectDeadline: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error("API response deadline exceeded"));
  }, timeoutMs);
  const request = async () => {
    const response = await fetcher(input, {
      ...init,
      signal: controller.signal,
    });
    if (!response.body) return response;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("API response size exceeded");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  try {
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
    controller.abort();
    // Cancellation must not delay the deadline or surface untrusted errors.
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
