/**
 * Speech to text, over the same chain everything else uses.
 *
 * WHY THIS IS HERE AND NOT IN EACH APP. The fleet had three hand-rolled
 * transcription clients — one in heidi, two in loki — and none of them had a
 * chain, a fallback, a health tracker or rate-limit classification. Each was a
 * single vendor and a single key, so a Groq blip took dictation down in every
 * app that had it, separately, with a different error message each time. The
 * registry has declared `kind: "transcribe"` since it was written, with nothing
 * behind it; this is the thing that was supposed to be behind it.
 *
 * The routing is NOT reimplemented. `walkChain` decides what a dead vendor is,
 * when a rejected key condemns a whole provider, and when to stop — and it must
 * have exactly one answer to those questions or the fleet ends up with two.
 * Only the request differs, which is the whole reason this file is short.
 *
 * THE MODELS ARE THE CALLER'S. A chain of chat models is not a chain of
 * transcription models, and guessing one from the other is how an app ends up
 * POSTing audio at a text endpoint. The caller passes a chain whose models
 * transcribe; the registry's `kind` field is what an app uses to build it.
 */
import { LinkFailure, linkId } from "./complete.js";
import { classifyRateLimit, retryAfterSeconds } from "./limits.js";
import { walkChain, type WalkOptions } from "./walk.js";
import type { Link } from "./chain.js";

/** Long enough for a slow speaker; short enough that a stall is not a hang. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface TranscribeOptions extends WalkOptions {
  /**
   * The recording. A `Blob` or `File` — whatever `FormData` will accept.
   *
   * Deliberately not a path or a stream: this runs in a server route holding a
   * request body, and reading from disk is a different problem with different
   * failure modes.
   */
  audio: Blob;
  /**
   * Filename sent with the part. Some vendors sniff the container from the
   * extension and reject a part that has none, so there is a default rather
   * than an optional field the caller forgets.
   */
  filename?: string;
  /**
   * ISO-639-1 hint, e.g. `de`. Worth passing: without it a short recording is
   * routinely detected as the wrong language, and the transcript comes back
   * fluent, confident and in Dutch.
   */
  language?: string;
  /** Nudge for names and jargon the model will not otherwise spell. */
  prompt?: string;
  /**
   * Ask for word-level timings as well as the text.
   *
   * Opt-in because it changes the request (`verbose_json` plus
   * `timestamp_granularities[]=word`) and makes the body several times larger,
   * and dictation — the common caller — needs only the text. A caller measuring
   * HOW something was said (speech rate, pauses between words, length of run)
   * cannot do it without them: the text says which words, only the timings say
   * when.
   */
  words?: boolean;
  /** How long ONE link may take before the next is tried. Default 30s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** One recognised word and when it was said, in seconds from the start. */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscribeResult {
  text: string;
  /**
   * Word timings, when `words: true` was asked for AND the vendor supplied them.
   *
   * ABSENT is not EMPTY, and the difference is the whole contract. `undefined`
   * means "not measured" — timings were not requested, or this vendor ignored
   * the granularity and returned text only. `[]` means "measured, and there
   * were no words", which is what a silent recording truthfully is. A caller
   * that read absence as zero words would report a fluent speaker as having
   * said nothing at all.
   */
  words?: TimedWord[];
  /** `provider/model`, so a log says which vendor actually answered. */
  id: string;
  link: Link;
  /** The vendor's parsed body, for a caller that wants segments or timings. */
  raw: unknown;
}

function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * One link's attempt.
 *
 * Throws `LinkFailure` for anything that means "this vendor did not serve the
 * turn", which is what tells `walkChain` to try the next one.
 */
async function transcribeLink(
  link: Link,
  options: TranscribeOptions,
  key: string,
): Promise<TranscribeResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  const form = new FormData();
  form.set("file", options.audio, options.filename ?? "audio.webm");
  form.set("model", link.model);
  if (options.language) form.set("language", options.language);
  if (options.prompt) form.set("prompt", options.prompt);
  if (options.words) {
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
  } else {
    form.set("response_format", "json");
  }

  // Its own budget per link, for the same reason `complete()` has one: a vendor
  // that accepts the connection and never answers is the outage a fallback
  // chain is least able to survive, because without a deadline link two is
  // never reached.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = new AbortController();
  const onAbort = () => timer.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = timeoutMs > 0 ? setTimeout(() => timer.abort(), timeoutMs) : undefined;

  let res: Response;
  try {
    res = await doFetch(`${link.provider.baseUrl}/audio/transcriptions`, {
      method: "POST",
      // No content-type: `fetch` sets it from the FormData, including the
      // multipart boundary. Setting it by hand omits the boundary and every
      // vendor answers 400 on a body it cannot split.
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: timer.signal,
    });
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    throw new LinkFailure(
      link,
      `${linkId(link)}: ${aborted ? `no answer in ${timeoutMs}ms` : String(error)}`,
      {},
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }

  const text = await res.text();

  if (!res.ok) {
    if (res.status === 429) {
      // Classified, so a daily cap condemns the vendor and a busy minute does
      // not — the same distinction the text path makes, from the same function.
      const kind = classifyRateLimit(text);
      throw new LinkFailure(link, `${linkId(link)}: 429 ${kind} — ${excerpt(text)}`, {
        status: 429,
        kind,
        // Parsed out of the vendor's PROSE ("try again in 2m30s"), which is
        // where it actually appears — the same source the text path reads.
        retryAfter: retryAfterSeconds(text),
      });
    }
    throw new LinkFailure(link, `${linkId(link)}: ${res.status} — ${excerpt(text)}`, {
      status: res.status,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LinkFailure(link, `${linkId(link)}: 200 with unparseable body — ${excerpt(text)}`, {
      status: res.status,
    });
  }

  const transcript = (parsed as { text?: unknown })?.text;
  if (typeof transcript !== "string") {
    throw new LinkFailure(link, `${linkId(link)}: 200 with no text field — ${excerpt(text)}`, {
      status: res.status,
    });
  }

  // An empty transcript is NOT a failure. Silence, or a recording of a closed
  // window, genuinely transcribes to nothing — and demoting it would walk the
  // whole chain re-uploading the same audio to every vendor to be told the same
  // true thing, slowly and at the caller's expense.
  // Missing timings do NOT fail the link. The text is still a good answer, and
  // walking the chain to find a vendor that honours the granularity would
  // re-upload the same audio to each of them for a nice-to-have. The caller
  // sees `words: undefined` and says "not measured" instead.
  const words = options.words ? timedWords(parsed) : undefined;
  return { text: transcript, id: linkId(link), link, raw: parsed, ...(words ? { words } : {}) };
}

/**
 * The vendor's `words` array, normalised, or undefined if it sent none.
 *
 * Entries with a non-finite time, an end before their start, or no text are
 * dropped rather than trusted: one negative duration propagates into every
 * rate computed from it as a number that looks measured.
 */
export function timedWords(body: unknown): TimedWord[] | undefined {
  const list = (body as { words?: unknown })?.words;
  if (!Array.isArray(list)) return undefined;
  const out: TimedWord[] = [];
  for (const entry of list) {
    const w = entry as { word?: unknown; start?: unknown; end?: unknown };
    if (typeof w?.word !== "string" || !w.word.trim()) continue;
    if (typeof w.start !== "number" || typeof w.end !== "number") continue;
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start) continue;
    out.push({ word: w.word.trim(), start: w.start, end: w.end });
  }
  return out;
}

/**
 * Transcribe a recording on the first link that works.
 *
 * Throws `ChainExhaustedError` carrying every link's failure, so a log shows
 * what was actually tried rather than only the last thing that broke.
 */
export async function transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
  return walkChain(options, (link, key) => transcribeLink(link, options, key));
}
