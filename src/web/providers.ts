/**
 * Search backends.
 *
 * Three, on purpose, and in this order of preference:
 *
 *   searxng — self-hosted, no API key, no per-call cost, no third party told
 *             what your users are looking for. A metasearch front end over the
 *             engines you enable. The catch is that it is scraping on your
 *             behalf from your own IP, so a datacenter host will sometimes be
 *             refused by upstream engines; that failure is loud here, which is
 *             why the chain exists.
 *   brave   — an independent index (not a Bing or Google reseller) with a free
 *             tier, so the fallback is not the same index the primary was
 *             already asking.
 *   tavily  — built for agents: it returns cleaned content rather than SERP
 *             chrome. Last resort because it is the most expensive per call.
 *
 * The seam is one method wide deliberately. Every provider here also sells
 * "AI answers", news verticals and summarisation; adopting any of those would
 * make the backends non-interchangeable, and an interchangeable backend is the
 * entire reason to have a seam. Summarising is the model's job and it happens
 * upstream of this file.
 *
 * None of them throws. A provider that cannot answer returns a typed failure,
 * because the chain has to tell "no results" apart from "no answer" to pick
 * its next move — and so does the model reading the result.
 */
import type { SearchOutcome, SearchProvider, WebEnv, WebFailure, WebResult } from "./types.js";

const DEFAULT_LIMIT = 8;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_LIMIT = 20;

type Fetch = typeof globalThis.fetch;

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** `site:` is spelled the same by every engine here, so it is applied once. */
function applySite(query: string, site: string | undefined): string {
  const trimmed = site?.trim();
  if (!trimmed) return query;
  return `${query} site:${trimmed.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
}

function transportFailure(err: unknown): WebFailure {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "timeout", reason: "The search backend did not answer in time." };
  }
  return { kind: "unreachable", reason: `The search backend could not be reached (${message}).` };
}

/** HTTP status → failure kind. Shared because every provider gets this wrong the same way. */
function statusFailure(status: number, provider: string): WebFailure {
  if (status === 429) {
    return { kind: "rate_limited", reason: `${provider} is rate-limiting this key right now.` };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", reason: `${provider} rejected the credentials (${status}).` };
  }
  return { kind: "bad_response", reason: `${provider} answered ${status}.` };
}

function trimResult(raw: {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  published?: unknown;
  engine?: unknown;
}): WebResult | null {
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url || !/^https?:\/\//i.test(url)) {
    return null;
  }
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : url;
  const snippet = typeof raw.snippet === "string" ? raw.snippet.trim().slice(0, 600) : "";
  const published =
    typeof raw.published === "string" && raw.published.trim() ? raw.published.trim() : undefined;
  const engine =
    typeof raw.engine === "string" && raw.engine.trim() ? raw.engine.trim() : undefined;
  return {
    title: title.slice(0, 300),
    url,
    snippet,
    ...(published ? { published } : {}),
    ...(engine ? { engine } : {}),
  };
}

// ── SearXNG ────────────────────────────────────────────────────────────────
// Needs `formats: [html, json]` in the instance's settings.yml — a stock
// instance serves HTML only and answers a JSON request with 403, which is
// reported here as an auth failure so the operator sees the real fix rather
// than "no results".

export function searxngProvider(env: WebEnv, doFetch: Fetch = globalThis.fetch): SearchProvider {
  const base = env.SEARXNG_URL?.trim().replace(/\/+$/, "");
  return {
    name: "searxng",
    configured: () => Boolean(base),
    async search(query, opts): Promise<SearchOutcome> {
      if (!base) {
        return {
          ok: false,
          provider: "searxng",
          query,
          failure: { kind: "not_configured", reason: "SEARXNG_URL is not set." },
        };
      }
      const url = new URL(`${base}/search`);
      url.searchParams.set("q", applySite(query, opts.site));
      url.searchParams.set("format", "json");
      url.searchParams.set("safesearch", "0");
      if (opts.lang) {
        url.searchParams.set("language", opts.lang);
      }
      try {
        const res = await doFetch(url.toString(), {
          headers: {
            Accept: "application/json",
            ...(env.SEARXNG_TOKEN ? { Authorization: `Bearer ${env.SEARXNG_TOKEN}` } : {}),
          },
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!res.ok) {
          return {
            ok: false,
            provider: "searxng",
            query,
            failure: statusFailure(res.status, "SearXNG"),
          };
        }
        const body = (await res.json()) as { results?: unknown };
        const rows = Array.isArray(body.results) ? body.results : [];
        const results = rows
          .map((r) => {
            const row = r as Record<string, unknown>;
            return trimResult({
              title: row.title,
              url: row.url,
              snippet: row.content,
              published: row.publishedDate,
              engine: row.engine,
            });
          })
          .filter((r): r is WebResult => r !== null)
          .slice(0, clampLimit(opts.limit));
        return { ok: true, provider: "searxng", query, results };
      } catch (err) {
        return { ok: false, provider: "searxng", query, failure: transportFailure(err) };
      }
    },
  };
}

// ── Brave ──────────────────────────────────────────────────────────────────

export function braveProvider(env: WebEnv, doFetch: Fetch = globalThis.fetch): SearchProvider {
  const key = env.BRAVE_SEARCH_API_KEY?.trim();
  return {
    name: "brave",
    configured: () => Boolean(key),
    async search(query, opts): Promise<SearchOutcome> {
      if (!key) {
        return {
          ok: false,
          provider: "brave",
          query,
          failure: { kind: "not_configured", reason: "BRAVE_SEARCH_API_KEY is not set." },
        };
      }
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", applySite(query, opts.site));
      url.searchParams.set("count", String(clampLimit(opts.limit)));
      if (opts.lang) {
        url.searchParams.set("search_lang", opts.lang.split("-")[0] ?? opts.lang);
      }
      try {
        const res = await doFetch(url.toString(), {
          headers: { Accept: "application/json", "X-Subscription-Token": key },
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!res.ok) {
          return {
            ok: false,
            provider: "brave",
            query,
            failure: statusFailure(res.status, "Brave Search"),
          };
        }
        const body = (await res.json()) as { web?: { results?: unknown } };
        const rows = Array.isArray(body.web?.results) ? body.web.results : [];
        const results = rows
          .map((r) => {
            const row = r as Record<string, unknown>;
            return trimResult({
              title: row.title,
              url: row.url,
              snippet: row.description,
              published: row.page_age,
              engine: "brave",
            });
          })
          .filter((r): r is WebResult => r !== null);
        return { ok: true, provider: "brave", query, results };
      } catch (err) {
        return { ok: false, provider: "brave", query, failure: transportFailure(err) };
      }
    },
  };
}

// ── Tavily ─────────────────────────────────────────────────────────────────

export function tavilyProvider(env: WebEnv, doFetch: Fetch = globalThis.fetch): SearchProvider {
  const key = env.TAVILY_API_KEY?.trim();
  return {
    name: "tavily",
    configured: () => Boolean(key),
    async search(query, opts): Promise<SearchOutcome> {
      if (!key) {
        return {
          ok: false,
          provider: "tavily",
          query,
          failure: { kind: "not_configured", reason: "TAVILY_API_KEY is not set." },
        };
      }
      try {
        const res = await doFetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            query: applySite(query, opts.site),
            max_results: clampLimit(opts.limit),
            search_depth: "basic",
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!res.ok) {
          return {
            ok: false,
            provider: "tavily",
            query,
            failure: statusFailure(res.status, "Tavily"),
          };
        }
        const body = (await res.json()) as { results?: unknown };
        const rows = Array.isArray(body.results) ? body.results : [];
        const results = rows
          .map((r) => {
            const row = r as Record<string, unknown>;
            return trimResult({
              title: row.title,
              url: row.url,
              snippet: row.content,
              published: row.published_date,
              engine: "tavily",
            });
          })
          .filter((r): r is WebResult => r !== null);
        return { ok: true, provider: "tavily", query, results };
      } catch (err) {
        return { ok: false, provider: "tavily", query, failure: transportFailure(err) };
      }
    },
  };
}

/**
 * The default chain, in preference order, filtered to what the env configures.
 *
 * A caller that wants a different order passes its own array — this function
 * exists so that the common case ("use whatever we have") is one call and not
 * a policy decision re-made in every app, which is how the fleet ended up with
 * one model-fallback implementation per repo.
 */
export function defaultProviders(env: WebEnv, doFetch: Fetch = globalThis.fetch): SearchProvider[] {
  return [
    searxngProvider(env, doFetch),
    braveProvider(env, doFetch),
    tavilyProvider(env, doFetch),
  ].filter((p) => p.configured());
}

export { DEFAULT_LIMIT, DEFAULT_TIMEOUT_MS, MAX_LIMIT };
