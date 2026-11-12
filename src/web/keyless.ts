/**
 * Keyless backends — for when every configured search backend is down.
 *
 * The default chain (providers.ts) leans on a self-hosted SearXNG, and the
 * file says why that is fragile: it scrapes upstream engines from a datacenter
 * address, and those engines refuse it from time to time. When it fails and no
 * paid key is configured, an agent cannot look anything up at all. These two
 * backends need no key and no account, so an app can put them at the END of
 * its chain and still see something:
 *
 *   gdelt     — the GDELT Project's DOC 2.0 API: worldwide news coverage, a
 *               rolling window of the last three months, searched by keyword.
 *   wikipedia — the MediaWiki search API of one Wikipedia language edition.
 *
 * Both are PARTIAL indexes (`coverage: "partial"`): one is news only, the other
 * one encyclopedia. An empty answer from either is therefore never reported as
 * "nothing on the web" — the chain walks past it and, if nothing else answered,
 * still says it could not look (search.ts).
 *
 * Neither is in `defaultProviders`: which slices of the web an app is willing
 * to answer from is the app's call. `withKeylessFallback(env)` is the one-line
 * way to opt in.
 *
 * GDELT asks callers to "limit requests to one every 5 seconds" (its answer to
 * a faster caller, seen 2026-11-12, after which it reset connections). So the
 * provider paces itself across every instance in the process: a call waits for
 * its slot, and when the slot is further away than the call's deadline it
 * fails as `rate_limited` without sending anything.
 */
import type { SearchOutcome, SearchProvider, WebFailure, WebResult } from "./types.js";
import { DEFAULT_TIMEOUT_MS, MAX_LIMIT, defaultProviders } from "./providers.js";
import type { WebEnv } from "./types.js";

type Fetch = typeof globalThis.fetch;

export type KeylessOptions = {
  /** Sent as User-Agent. Wikimedia asks every API client to name itself and a contact. */
  userAgent?: string;
  /** Wikipedia language edition when a search gives no language hint. Default "en". */
  wikipediaLang?: string;
  /** Minimum gap between GDELT requests in this process. Default 5000 ms, GDELT's own ask. */
  gdeltIntervalMs?: number;
};

const DEFAULT_USER_AGENT = "bitbaum-ai-kit (+https://github.com/bitbaum/ai-kit)";
const DEFAULT_GDELT_INTERVAL_MS = 5_000;
/** The least time worth sending a GDELT request with. */
const MIN_REQUEST_MS = 1_000;

function limitOf(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 8;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function transport(err: unknown, name: string): WebFailure {
  const kind = err instanceof Error ? err.name : "";
  if (kind === "TimeoutError" || kind === "AbortError") {
    return { kind: "timeout", reason: `${name} did not answer in time.` };
  }
  return { kind: "unreachable", reason: `${name} could not be reached.` };
}

function status(code: number, name: string): WebFailure {
  if (code === 429)
    return { kind: "rate_limited", reason: `${name} is rate-limiting this caller.` };
  if (code === 401 || code === 403)
    return { kind: "blocked", reason: `${name} refused this caller (${code}).` };
  return { kind: "bad_response", reason: `${name} answered ${code}.` };
}

/** The host of a `site` option, without scheme or path. */
function hostOf(site: string | undefined): string | undefined {
  const host = site
    ?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return host || undefined;
}

// ── GDELT ──────────────────────────────────────────────────────────────────

/** When the next GDELT request may be sent. Per process: GDELT counts per caller address. */
let gdeltNextAt = 0;

/** For tests: forget the pacing state. */
export function resetGdeltPacing(): void {
  gdeltNextAt = 0;
}

const GDELT_LANGUAGE: Record<string, string> = {
  en: "english",
  de: "german",
  fr: "french",
  it: "italian",
  es: "spanish",
  pt: "portuguese",
  nl: "dutch",
  ja: "japanese",
  zh: "chinese",
};

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Letters and digits in a token, outside quotes and parentheses. */
function lettersIn(token: string): number {
  return token.replace(/[^\p{L}\p{N}]/gu, "").length;
}

/**
 * The query GDELT is sent. GDELT refuses a keyword it calls too short (seen
 * live: "AI chips" → "Your search contained a keyword that was too short"),
 * so a one- or two-letter word is joined to its neighbour as a quoted phrase
 * ("AI chips" → `"AI chips"`) rather than dropped, which would answer a
 * broader question than was asked. A short word in lower case is a function
 * word ("is", "of") and goes; a lone short name with no neighbour goes too.
 * CJK words are quoted, not measured. `OR` and the parentheses grouping it are
 * kept; parentheses without an `OR` go (GDELT accepts them only around OR'd
 * terms), and so do unbalanced quotes. `site` becomes `domain:`, a language
 * hint `sourcelang:`.
 */
export function gdeltQuery(query: string, opts: { site?: string; lang?: string } = {}): string {
  let q = query.replace(/[“”„]/g, '"');
  if ((q.match(/"/g) ?? []).length % 2) q = q.replace(/"/g, " ");
  if (!/\sOR\s/.test(q)) q = q.replace(/[()]/g, " ");
  const all = [...q.matchAll(/"[^"]+"|\S+/g)].map((m) => m[0]);
  const special = (t: string) => t === "OR" || t.startsWith('"') || CJK.test(t);
  // A short word in lower case is a function word ("is", "of", "in"): it goes.
  // A short one in capitals or with a digit is a name ("AI", "EU", "5G"): it stays.
  const acronym = (t: string) => /^[\p{Lu}\p{N}]+$/u.test(t.replace(/[^\p{L}\p{N}]/gu, ""));
  const tokens = all.filter(
    (t) => special(t) || lettersIn(t) >= 3 || (lettersIn(t) > 0 && acronym(t)),
  );
  const plain = (t: string | undefined): t is string =>
    !!t && !special(t) && !/[()]/.test(t) && lettersIn(t) >= 3;
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "OR" || t.startsWith('"')) {
      out.push(t);
    } else if (CJK.test(t)) {
      out.push(`"${t.replace(/[()]/g, "")}"`);
    } else if (lettersIn(t) >= 3) {
      out.push(t);
    } else if (!/[()]/.test(t) && plain(tokens[i + 1])) {
      out.push(`"${t} ${tokens[i + 1]}"`);
      i++;
    } else if (!/[()]/.test(t) && plain(out.at(-1))) {
      out[out.length - 1] = `"${out.at(-1)} ${t}"`;
    }
  }
  const host = hostOf(opts.site);
  if (host) out.push(`domain:${host}`);
  const lang = GDELT_LANGUAGE[(opts.lang ?? "").toLowerCase().split("-")[0] ?? ""];
  if (lang) out.push(`sourcelang:${lang}`);
  return out.join(" ");
}

/** "20261110T050000Z" → "2026-11-10T05:00:00Z"; anything else → undefined. */
function gdeltDate(raw: unknown): string | undefined {
  const m =
    typeof raw === "string" ? raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : undefined;
}

export function gdeltProvider(
  options: KeylessOptions = {},
  doFetch: Fetch = globalThis.fetch,
): SearchProvider {
  const asked = options.gdeltIntervalMs;
  // A bad interval would corrupt the pacing every GDELT caller in the process shares.
  const interval =
    typeof asked === "number" && Number.isFinite(asked) && asked >= 0
      ? asked
      : DEFAULT_GDELT_INTERVAL_MS;
  const name = "gdelt";
  const fail = (query: string, failure: WebFailure): SearchOutcome => ({
    ok: false,
    provider: name,
    query,
    failure,
  });
  return {
    name,
    coverage: "partial",
    configured: () => true,
    async search(query, opts): Promise<SearchOutcome> {
      const q = gdeltQuery(query, opts);
      if (!q.replace(/\b(domain|sourcelang):\S+/g, "").trim()) {
        return { ok: true, provider: name, query, results: [] };
      }
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const now = Date.now();
      const slot = Math.max(now, gdeltNextAt);
      // Not worth a slot: a request left with under a second would only time out.
      if (timeoutMs - (slot - now) < MIN_REQUEST_MS) {
        return fail(query, {
          kind: "rate_limited",
          reason:
            "GDELT allows one request every few seconds and this one could not wait its turn.",
        });
      }
      gdeltNextAt = slot + interval;
      if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));

      const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
      url.searchParams.set("query", q);
      url.searchParams.set("mode", "artlist");
      url.searchParams.set("format", "json");
      url.searchParams.set("maxrecords", String(limitOf(opts.limit)));
      try {
        const res = await doFetch(url.toString(), {
          headers: {
            Accept: "application/json",
            "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
          },
          signal: AbortSignal.timeout(Math.max(1, timeoutMs - (slot - now))),
        });
        if (!res.ok) return fail(query, status(res.status, "GDELT"));
        const text = await res.text();
        let body: { articles?: unknown } | null;
        try {
          body = JSON.parse(text) as { articles?: unknown } | null;
        } catch {
          // GDELT answers a refused query with a sentence, not JSON, and HTTP 200.
          return fail(
            query,
            /limit requests/i.test(text)
              ? { kind: "rate_limited", reason: "GDELT asked this caller to slow down." }
              : {
                  kind: "bad_response",
                  reason: "GDELT answered with a message instead of results.",
                },
          );
        }
        if (!body || typeof body !== "object") {
          return fail(query, {
            kind: "bad_response",
            reason: "GDELT answered with something other than results.",
          });
        }
        const rows = Array.isArray(body.articles) ? body.articles : [];
        const results: WebResult[] = [];
        for (const r of rows) {
          if (!r || typeof r !== "object") continue;
          const row = r as Record<string, unknown>;
          const link = typeof row.url === "string" ? row.url.trim() : "";
          if (!/^https?:\/\//i.test(link)) continue;
          const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : link;
          // GDELT's DOC API sorts and filters on "publication date"; seendate is that date.
          const published = gdeltDate(row.seendate);
          results.push({
            title: title.slice(0, 300),
            url: link,
            snippet: "",
            ...(published ? { published } : {}),
            engine: "gdelt",
          });
        }
        return { ok: true, provider: name, query, results: results.slice(0, limitOf(opts.limit)) };
      } catch (err) {
        return fail(query, transport(err, "GDELT"));
      }
    },
  };
}

// ── Wikipedia ──────────────────────────────────────────────────────────────

/** The text of a MediaWiki search snippet: its highlight markup and entities removed. */
function snippetText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

/**
 * The Wikipedia edition a language names: "de-CH" → "de", "zh-yue" stays
 * (it is an edition of its own), "simple" stays. Undefined when it names none.
 */
function editionFor(lang: string | undefined): string | undefined {
  const code = lang?.trim().toLowerCase();
  if (!code) return undefined;
  if (
    /^(simple|zh-yue|zh-min-nan|zh-classical|be-tarask|bat-smg|roa-rup|nds-nl|map-bms|fiu-vro)$/.test(
      code,
    )
  )
    return code;
  const primary = code.split(/[-_]/)[0];
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

export function wikipediaProvider(
  options: KeylessOptions = {},
  doFetch: Fetch = globalThis.fetch,
): SearchProvider {
  const name = "wikipedia";
  const fail = (query: string, failure: WebFailure): SearchOutcome => ({
    ok: false,
    provider: name,
    query,
    failure,
  });
  return {
    name,
    coverage: "partial",
    configured: () => true,
    async search(query, opts): Promise<SearchOutcome> {
      const site = hostOf(opts.site)?.replace(/^www\./, "");
      // A search limited to one edition ("de.wikipedia.org") searches that edition.
      const siteEdition = site?.match(/^([a-z][a-z0-9-]*)\.(?:m\.)?wikipedia\.org$/)?.[1];
      // Restricted to another site: Wikipedia has nothing there by construction.
      if (site && !siteEdition && site !== "wikipedia.org") {
        return { ok: true, provider: name, query, results: [] };
      }
      const lang =
        siteEdition ?? editionFor(opts.lang) ?? editionFor(options.wikipediaLang) ?? "en";
      const host = `${lang}.wikipedia.org`;
      const url = new URL(`https://${host}/w/api.php`);
      url.searchParams.set("action", "query");
      url.searchParams.set("list", "search");
      url.searchParams.set("srsearch", query);
      url.searchParams.set("srlimit", String(limitOf(opts.limit)));
      url.searchParams.set("srprop", "snippet");
      url.searchParams.set("format", "json");
      url.searchParams.set("formatversion", "2");
      try {
        const res = await doFetch(url.toString(), {
          headers: {
            Accept: "application/json",
            "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
          },
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!res.ok) return fail(query, status(res.status, "Wikipedia"));
        const body = (await res.json().catch(() => null)) as {
          query?: { search?: unknown };
          error?: { code?: unknown };
        } | null;
        // MediaWiki reports a refused search (maxlag, read-only, a bad
        // parameter) in a 200 JSON body: an error, never an empty search.
        if (!body || typeof body !== "object" || body.error) {
          return fail(query, {
            kind: "bad_response",
            reason: `Wikipedia answered with an error${typeof body?.error?.code === "string" ? ` (${body.error.code})` : ""}.`,
          });
        }
        const rows = Array.isArray(body.query?.search) ? body.query.search : [];
        const results: WebResult[] = [];
        for (const r of rows) {
          if (!r || typeof r !== "object") continue;
          const row = r as Record<string, unknown>;
          const title = typeof row.title === "string" ? row.title.trim() : "";
          if (!title) continue;
          results.push({
            title: title.slice(0, 300),
            url: `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
            // No `published`: the API's timestamp is the last edit, not a publication date.
            snippet: snippetText(row.snippet),
            engine: "wikipedia",
          });
        }
        return { ok: true, provider: name, query, results };
      } catch (err) {
        return fail(query, transport(err, "Wikipedia"));
      }
    },
  };
}

/** The keyless backends, news first: for "what changed" a news archive answers, an encyclopedia rarely does. */
export function keylessProviders(
  options: KeylessOptions = {},
  doFetch: Fetch = globalThis.fetch,
): SearchProvider[] {
  return [gdeltProvider(options, doFetch), wikipediaProvider(options, doFetch)];
}

/** The configured chain, then the keyless backends: one call to opt in. */
export function withKeylessFallback(
  env: WebEnv,
  options: KeylessOptions = {},
  doFetch: Fetch = globalThis.fetch,
): SearchProvider[] {
  return [...defaultProviders(env, doFetch), ...keylessProviders(options, doFetch)];
}
