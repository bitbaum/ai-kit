/**
 * The same chain, with the tokens arriving as they are produced.
 *
 * WHY THIS EXISTS
 *
 * Until now this package could not stream. `complete()` is request/response
 * only, so every app that wanted tokens to appear as they arrived used ai-kit
 * for chain selection, 429 classification and health — and then threw all of
 * it away for the one call that matters, hand-rolling a provider client.
 * Measured across the fleet on 2026-09-15: six such clients, four SSE readers
 * (two of them dropping frames on chunk boundaries), and four emitters with
 * divergent headers. The duplication was real, and it was in the wrong place:
 * the apps were not reinventing streaming because streaming is hard, but
 * because the package that owned the chain had no door for it.
 *
 * WHERE THE FALLBACK STOPS, AND WHY
 *
 * A non-streaming walk can try every link, because nothing has been shown to
 * the reader until it returns. A streaming walk cannot. Once the first token
 * has been yielded, falling back to another vendor would replay the answer
 * from the beginning — the reader would watch it restart, or worse, watch two
 * half-answers concatenate.
 *
 * So the boundary is explicit: a link that fails BEFORE its first delta is a
 * link failure and the walk continues, exactly as `complete()` would. A link
 * that fails AFTER it has produced output throws `StreamInterrupted` to the
 * caller. There is no silent recovery, because there is no honest one.
 *
 * This is the reason `openStream` returns only once a first delta has been
 * read: "the vendor answered 200" is not the same claim as "the vendor is
 * producing tokens", and a 200 that then dies is exactly the outage this
 * package already refuses to report as success elsewhere.
 */
import type { Link } from "./chain.js";
import {
  LinkFailure,
  linkId,
  type ChatMessage,
  type CompleteOptions,
  type ToolCall,
} from "./complete.js";
import { classifyRateLimit, retryAfterSeconds } from "./limits.js";
import { readQuota, readingFromRefusal, type QuotaReading } from "./meter.js";
import { walkChain } from "./walk.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** One piece of a turn as it arrives. */
export type StreamDelta =
  /** Text to append. Never empty. */
  | { type: "text"; text: string }
  /**
   * A tool call being assembled. `args` arrives in fragments and is only valid
   * JSON once `end` has been seen for that index.
   */
  | { type: "tool"; index: number; id?: string; name?: string; args?: string }
  /** The turn is over. Carries the assembled whole, so a caller need not. */
  | {
      type: "end";
      id: string;
      link: Link;
      text: string;
      toolCalls: ToolCall[];
      finishReason: string | null;
    };

/** A stream that had already produced output when it broke. */
export class StreamInterrupted extends Error {
  readonly link: Link;
  /** What the reader has already been shown. Not a complete turn. */
  readonly partial: string;
  constructor(link: Link, partial: string, cause: unknown) {
    super(
      `${linkId(link)}: stream broke after ${partial.length} character(s) — ` +
        `not retried on another link, because the reader has already seen this answer: ` +
        `${(cause as Error)?.message ?? String(cause)}`,
    );
    this.name = "StreamInterrupted";
    this.link = link;
    this.partial = partial;
    this.cause = cause;
  }
}

export interface CompleteStreamOptions extends CompleteOptions {
  messages: ChatMessage[];
}

function excerpt(body: string, limit = 300): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Split an SSE body into `data:` payloads, holding the remainder.
 *
 * The remainder is the whole point. A `ReadableStream` chunk is a TCP-sized
 * slice that ends wherever the network put the boundary — routinely mid-frame.
 * Two of the fleet's four hand-rolled readers split each chunk on newlines and
 * dropped whatever straddled the boundary, which loses a word from a long
 * answer under load and is invisible in every short test.
 */
export function sseFrames(buffer: string): { frames: string[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const frames: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(":") || line.startsWith("event:")) continue;
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload || payload === "[DONE]") continue;
    frames.push(payload);
  }
  return { frames, rest };
}

type OpenChoice = {
  delta?: {
    content?: unknown;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
};

/** Turn one OpenAI-shaped chunk into deltas. */
function deltasFrom(parsed: unknown): { deltas: StreamDelta[]; finishReason: string | null } {
  const choice = (parsed as { choices?: OpenChoice[] })?.choices?.[0];
  const deltas: StreamDelta[] = [];
  const content = choice?.delta?.content;
  if (typeof content === "string" && content !== "") deltas.push({ type: "text", text: content });
  for (const tc of choice?.delta?.tool_calls ?? []) {
    deltas.push({
      type: "tool",
      index: typeof tc.index === "number" ? tc.index : 0,
      ...(tc.id === undefined ? {} : { id: tc.id }),
      ...(tc.function?.name === undefined ? {} : { name: tc.function.name }),
      ...(tc.function?.arguments === undefined ? {} : { args: tc.function.arguments }),
    });
  }
  return { deltas, finishReason: choice?.finish_reason ?? null };
}

/**
 * Stream a turn from the first link that produces one.
 *
 * Yields `text` and `tool` deltas as they arrive, then exactly one `end`
 * carrying the assembled turn — so a caller that only wants the whole answer
 * can ignore everything until the last event, and a caller rendering live does
 * not have to accumulate it twice.
 *
 * Throws `ChainExhaustedError` if no link produced a first token, and
 * `StreamInterrupted` if one did and then broke. Those are different failures
 * and a caller must be able to tell them apart: the first is "nobody answered",
 * the second is "the reader is looking at half an answer".
 */
export async function* completeStream(
  options: CompleteStreamOptions,
): AsyncGenerator<StreamDelta, void, undefined> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  const report = (readings: QuotaReading[]) => {
    if (readings.length === 0 || !options.onQuota) return;
    try {
      options.onQuota(readings);
    } catch {
      /* the caller's sink is the caller's problem */
    }
  };

  // Open a link far enough to know it is really producing tokens. Returning
  // before the first delta would make every 200 look like a success, including
  // the ones that die immediately — and by then the walk is over and fallback
  // is no longer honest.
  const opened = await walkChain(options, async (link, key) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    let res: Response;
    try {
      res = await doFetch(`${link.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...options.extraHeaders,
          // Last on purpose — see callLink. A caller may override any header
          // but this one.
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: link.model,
          messages: options.messages,
          stream: true,
          ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.tools === undefined ? {} : { tools: options.tools }),
          ...options.extraBody,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      cleanup();
      throw new LinkFailure(link, `${linkId(link)}: ${(error as Error).message}`);
    }

    report(readQuota(res.headers, link));

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      cleanup();
      if (res.status === 429) {
        const kind = classifyRateLimit(text);
        const retryAfter = retryAfterSeconds(text);
        // `size` excluded for the same reason as in complete(): that 429 means
        // this prompt was too big, not that the allowance is gone.
        if (kind !== "size") report([readingFromRefusal(link, retryAfter)]);
        throw new LinkFailure(link, `${linkId(link)}: 429 ${kind} — ${excerpt(text)}`, {
          status: 429,
          kind,
          retryAfter,
        });
      }
      throw new LinkFailure(link, `${linkId(link)}: ${res.status} — ${excerpt(text)}`, {
        status: res.status,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const queued: StreamDelta[] = [];
    let finishReason: string | null = null;

    // Pull until the first delta, so a 200 that produces nothing demotes like
    // any other dead link instead of being reported as a served turn.
    try {
      while (queued.length === 0) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = sseFrames(buffer);
        buffer = rest;
        for (const f of frames) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(f);
          } catch {
            continue;
          }
          const got = deltasFrom(parsed);
          if (got.finishReason) finishReason = got.finishReason;
          queued.push(...got.deltas);
        }
      }
    } catch (error) {
      cleanup();
      reader.releaseLock();
      throw new LinkFailure(link, `${linkId(link)}: ${(error as Error).message}`);
    }

    if (queued.length === 0) {
      cleanup();
      reader.releaseLock();
      // A 200 that carries no content is an outage wearing a success code —
      // the same judgement complete() makes about an empty completion.
      throw new LinkFailure(link, `${linkId(link)}: 200 but the stream ended with no content`, {
        status: res.status,
      });
    }

    return { link, reader, decoder, buffer, queued, finishReason, cleanup };
  });

  const { link, reader, decoder, cleanup } = opened;
  let buffer = opened.buffer;
  let finishReason = opened.finishReason;
  const text: string[] = [];
  const tools = new Map<number, { id?: string; name?: string; args: string }>();

  const absorb = (d: StreamDelta) => {
    if (d.type === "text") text.push(d.text);
    else if (d.type === "tool") {
      const cur = tools.get(d.index) ?? { args: "" };
      if (d.id !== undefined) cur.id = d.id;
      if (d.name !== undefined) cur.name = d.name;
      if (d.args !== undefined) cur.args += d.args;
      tools.set(d.index, cur);
    }
  };

  try {
    for (const d of opened.queued) {
      absorb(d);
      yield d;
    }

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = sseFrames(buffer);
      buffer = rest;
      for (const f of frames) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(f);
        } catch {
          continue;
        }
        const got = deltasFrom(parsed);
        if (got.finishReason) finishReason = got.finishReason;
        for (const d of got.deltas) {
          absorb(d);
          yield d;
        }
      }
    }
  } catch (error) {
    // Already showed the reader something. Say so precisely rather than
    // pretending the chain can rescue it.
    throw new StreamInterrupted(link, text.join(""), error);
  } finally {
    cleanup();
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  const toolCalls: ToolCall[] = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ id: t.id ?? "", name: t.name ?? "", args: t.args }))
    .filter((t) => t.name !== "");

  options.health?.recordSuccess();
  yield {
    type: "end",
    id: linkId(link),
    link,
    text: text.join(""),
    toolCalls,
    finishReason,
  };
}
