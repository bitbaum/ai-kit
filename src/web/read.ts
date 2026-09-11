/**
 * readPage — fetch one web page and return its readable text.
 *
 * This is the other half of search. A result list gives an agent titles and a
 * sentence of snippet; almost every real question needs the page. Without a
 * reader the agent either answers from the snippet (which is how a plausible
 * wrong number gets into a reply) or says it cannot know, and both are worse
 * than reading.
 *
 * Three things it refuses to do, each because the alternative failed somewhere:
 *
 * - It never follows a redirect automatically. Every hop goes back through the
 *   SSRF guard, because a public URL that 302s to localhost is the cheapest
 *   bypass there is.
 * - It never returns partial bytes as though they were the page. When the cap
 *   is hit the result says `truncated: true`, so a model summarising it can say
 *   "the first part of the page says…" instead of implying it read the whole.
 * - It never throws. The caller is an agent loop; an unreadable page is a fact
 *   about the world to reason about, not an exception to unwind through.
 *
 * Extraction is deliberately regex-based and dependency-free. A DOM parser
 * would read more sites (SPAs especially) at the cost of making this package
 * depend on one, and the failure it would fix — a JS-rendered page yielding
 * nothing — is honestly reportable: empty text with `ok: true` tells the model
 * the page had nothing readable, which is true and useful.
 */
import type { PageOutcome, ReadOptions, WebFailure } from "./types.js";
import { validateFetchTarget, type LookupFn, defaultLookup } from "./ssrf.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

/** Content types worth extracting text from. Anything else is refused unread. */
const READABLE_TYPES = [
  "text/html",
  "application/xhtml",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
];

export type ReadDeps = {
  fetch?: typeof globalThis.fetch;
  lookup?: LookupFn;
};

export async function readPage(
  rawUrl: string,
  opts: ReadOptions = {},
  deps: ReadDeps = {},
): Promise<PageOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let target = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await validateFetchTarget(target, lookup);
    if (!verdict.ok) {
      return { ok: false, url: target, failure: { kind: "blocked", reason: verdict.reason } };
    }
    const url = verdict.url.toString();

    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          // Identifying the agent is the polite half of scraping and the half
          // that lets a site block us deliberately rather than by accident.
          "User-Agent": "ai-kit/web (+https://github.com/bitbaum/ai-kit)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Language": "en,de;q=0.8",
        },
      });
    } catch (err) {
      return { ok: false, url, failure: fetchFailure(err) };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return {
          ok: false,
          url,
          failure: { kind: "bad_response", reason: `Redirect ${res.status} with no destination.` },
        };
      }
      // Resolve relative Locations against the hop we are on, then loop — the
      // next iteration re-runs the full SSRF check on the new address.
      target = new URL(location, url).toString();
      continue;
    }

    if (res.status === 429) {
      return {
        ok: false,
        url,
        failure: { kind: "rate_limited", reason: "The site asked us to slow down (429)." },
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        url,
        failure: { kind: "blocked", reason: `The site refused the request (${res.status}).` },
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        url,
        failure: { kind: "bad_response", reason: `The site answered ${res.status}.` },
      };
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !READABLE_TYPES.some((t) => contentType.includes(t))) {
      return {
        ok: false,
        url,
        failure: {
          kind: "bad_response",
          reason: `That is a ${contentType.split(";")[0]} file, not a readable page.`,
        },
      };
    }

    let body: string;
    try {
      body = await readCapped(res, maxBytes);
    } catch (err) {
      return { ok: false, url, failure: fetchFailure(err) };
    }

    const extracted = extractReadableText(body, maxChars);
    return {
      ok: true,
      url,
      title: extracted.title,
      text: extracted.text,
      truncated: extracted.truncated,
    };
  }

  return {
    ok: false,
    url: target,
    failure: { kind: "blocked", reason: `More than ${MAX_REDIRECTS} redirects.` },
  };
}

/**
 * Read the body but stop at `maxBytes`. Buffering `res.text()` first and
 * slicing after would already have paid for the whole download, which is the
 * cost the cap exists to avoid — a 400 MB file would be in memory before the
 * limit was consulted.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

function fetchFailure(err: unknown): WebFailure {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(message)) {
    return { kind: "timeout", reason: "The site took too long to answer." };
  }
  return { kind: "unreachable", reason: `The site could not be reached (${message}).` };
}

const BLOCK_TAGS = "script|style|noscript|template|svg|canvas|iframe|form|nav|footer|header|aside";

export type ExtractedPage = { title: string; text: string; truncated: boolean };

/**
 * Strip a document to the text a reader would see.
 *
 * Order matters and is load-bearing: comments go first (they can contain
 * unbalanced tags that desync a later pass), then whole non-content elements
 * WITH their contents, then remaining tags, then entities. Doing entities
 * before tag-stripping would turn an encoded `&lt;script&gt;` in page text into
 * a real tag mid-pass.
 */
export function extractReadableText(html: string, maxChars = DEFAULT_MAX_CHARS): ExtractedPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  // Collapse whitespace: stripping an inline tag leaves a space behind, so a
  // title with any markup in it ("A <b>bold</b> title") otherwise arrives with
  // double spaces and fails to match the same string anywhere else.
  const title = titleMatch?.[1]
    ? decodeEntities(stripTags(titleMatch[1])).replace(/\s+/g, " ").trim().slice(0, 300)
    : "";

  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), " ");
  // An unclosed <script> would otherwise leave its whole tail in the text.
  body = body.replace(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>[\\s\\S]*$`, "i"), " ");
  // Keep block boundaries as newlines so lists and paragraphs do not run
  // together into one sentence the model then reads as a single claim.
  body = body.replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, "\n");
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = stripTags(body);
  body = decodeEntities(body);
  body = body
    .split("\n")
    // \u00a0 is the non-breaking space `&nbsp;` decodes to. Written as an escape,
    // not the literal character: a raw NBSP in source is invisible to a reviewer
    // and to a diff, which is how one survives a cleanup that silently changes
    // what the regex matches.
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  const truncated = body.length > maxChars;
  return { title, text: truncated ? body.slice(0, maxChars) : body, truncated };
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, " ");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}
