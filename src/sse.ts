/**
 * Server-sent events, both ends, once.
 *
 * WHY THIS IS IN THIS PACKAGE
 *
 * Measured across the fleet on 2026-09-15: four hand-rolled SSE readers and
 * four emitters, in nine apps carrying ~20,800 lines of chat UI between them.
 * Two of the readers are the same function under the same name, written
 * independently. Two others are WRONG in the same way, and it is the kind of
 * wrong that looks fine for months:
 *
 *     for (const line of chunk.split("\n")) { ... }      // no carry buffer
 *
 * A `ReadableStream` chunk is a TCP-sized slice, not a message. It ends
 * wherever the network put the boundary — routinely mid-frame. Split a chunk
 * on newlines with no remainder held back and the half-frame at the end is
 * parsed as garbage (dropped), and the half at the start of the NEXT chunk is
 * dropped too. The visible symptom is a word missing from a long answer under
 * load, which nobody reports and nobody can reproduce.
 *
 * `readEventStream` keeps the remainder. That is the whole difference, and it
 * is why this belongs in a package instead of in nine files.
 *
 * Lifted from loki `src/lib/api/sse.ts` + `src/lib/api/read-event-stream.ts`,
 * which had both halves right. Web APIs only — no Node, no framework.
 */

/** The headers that make a stream actually stream. */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  // `no-transform` is the load-bearing half: a proxy that helpfully gzips or
  // rewrites the body buffers it, and the client then gets the whole turn in
  // one lump at the end — the exact behaviour the stream exists to remove.
  "Cache-Control": "no-cache, no-transform",
  // nginx buffers proxied responses by default, which does the same thing.
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
} as const;

/** Frame one value as an SSE `data:` event. */
export function sseEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/**
 * Read an SSE body.
 *
 * `EventSource` is not an option for most of these: they are POSTs carrying a
 * session cookie and a JSON body, and EventSource can only GET.
 *
 * Deliberately tolerant of framing — comments, blank lines, `event:` lines and
 * the `[DONE]` sentinel are skipped, and a frame that fails to parse is dropped
 * rather than killing the stream. A malformed keepalive is not worth losing an
 * answer over.
 *
 * What it does NOT swallow is a throw from `onEvent`: a consumer uses that to
 * abort a turn, and catching it here would leave the caller waiting forever on
 * a stream it has already given up on.
 */
export async function readEventStream<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` matters for the same reason the buffer does: a chunk can
      // split a multi-byte character, and decoding it alone yields U+FFFD.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // The last element is whatever arrived after the final newline — it may
      // be half a frame, so it waits for the next chunk. Dropping it here is
      // the bug this function exists to not have.
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(":") || line.startsWith("event:")) continue;
        const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!payload || payload === "[DONE]") continue;
        let parsed: E;
        try {
          parsed = JSON.parse(payload) as E;
        } catch {
          continue;
        }
        onEvent(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run `job`, streaming whatever it emits, and close.
 *
 * `emit` is safe to call after the client has gone: writing to a closed
 * controller throws, and a turn aborted by the reader navigating away would
 * otherwise die with an unhandled rejection rather than simply stopping.
 *
 * For a one-shot job — a request that runs a single piece of work, reports
 * progress, and closes. A long-lived subscription needs keepalives and
 * listener teardown, and folding the two lifecycles together costs more than
 * the shared header block saves.
 */
export function sseResponse<E>(
  job: (emit: (event: E) => void, signal: AbortSignal) => Promise<void>,
  options: {
    /** Defaults to one `data:` line of JSON. */
    encode?: (event: E) => string;
    /** Usually the request's signal, so a disconnect stops the model calls. */
    signal?: AbortSignal;
    /**
     * Turn a thrown error into a final event.
     *
     * Without it a job that throws closes a 200 stream having said nothing, and
     * the client cannot tell that from a turn that legitimately produced no
     * answer. Silence is not a status.
     */
    onError?: (error: unknown) => E;
  } = {},
): Response {
  const encode = options.encode ?? ((e: E) => sseEvent(e));
  const encoder = new TextEncoder();
  // Closing over our own controller rather than the request's signal lets the
  // stream's cancel() (the reader navigating away, or pressing Stop) reach the
  // job, which is what actually stops the model calls.
  const abort = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: E) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encode(event)));
        } catch {
          // The client is gone. Stop trying to talk to it, and let the job's
          // own signal wind it down.
          open = false;
          abort.abort();
        }
      };
      try {
        await job(emit, abort.signal);
      } catch (e) {
        // Aborting is the reader pressing Stop, not a failure to report.
        if (options.onError && !abort.signal.aborted) emit(options.onError(e));
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed by a cancelled client */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
