/**
 * webSearch — walk the provider chain and come back with one of THREE answers.
 *
 * The three-answer shape is the whole point of this file, and it is the same
 * lesson the model chain in `chain.ts` learned: a list nobody walks is not a
 * fallback, and a walk that cannot say why it ended is not an answer.
 *
 *   found        — results, and which backend produced them.
 *   nothing      — at least one backend ANSWERED and had nothing. This is a
 *                  real negative the model may state as one.
 *   could_not    — no backend answered at all (none configured, all rate-
 *                  limited, all unreachable). The model must NOT report this
 *                  as "there is nothing about X"; it must say it could not
 *                  look, and the `attempts` list says why for each backend.
 *
 * Collapsing the last two into `[]` is the specific bug this prevents. It has
 * a track record: an assistant whose search silently returned nothing told a
 * user their question had no answer on the internet, and the actual cause was
 * an expired API key. The user cannot fix a key they were never told about,
 * and neither can the operator, because the failure looked like a fact.
 *
 * Walking past an EMPTY-but-successful backend is deliberate. A self-hosted
 * metasearch instance whose upstream engines refused it returns `{results: []}`
 * with HTTP 200 — a success that carries no information — so the chain tries
 * the next backend before concluding, and only reports `nothing` when every
 * backend that answered agreed there was nothing.
 */
import type { SearchOptions, SearchProvider, WebEnv, WebFailure, WebResult } from "./types.js";
import { defaultProviders } from "./providers.js";

/** What one backend did, kept for the report even when a later one succeeded. */
export type SearchAttempt = {
  provider: string;
  outcome: "results" | "empty" | "failed";
  count?: number;
  failure?: WebFailure;
};

export type WebSearchResult =
  | {
      status: "found";
      results: WebResult[];
      provider: string;
      query: string;
      attempts: SearchAttempt[];
    }
  | { status: "nothing"; query: string; attempts: SearchAttempt[] }
  | { status: "could_not_look"; query: string; attempts: SearchAttempt[] };

export type WebSearchDeps = {
  env?: WebEnv;
  providers?: SearchProvider[];
  fetch?: typeof globalThis.fetch;
};

export async function webSearch(
  query: string,
  opts: SearchOptions = {},
  deps: WebSearchDeps = {},
): Promise<WebSearchResult> {
  const trimmed = query.trim();
  const attempts: SearchAttempt[] = [];

  if (!trimmed) {
    return { status: "could_not_look", query, attempts };
  }

  const env = deps.env ?? (process.env as WebEnv);
  const providers = deps.providers ?? defaultProviders(env, deps.fetch ?? globalThis.fetch);

  if (providers.length === 0) {
    return {
      status: "could_not_look",
      query: trimmed,
      attempts: [
        {
          provider: "none",
          outcome: "failed",
          failure: {
            kind: "not_configured",
            reason:
              "No search backend is configured (set SEARXNG_URL, BRAVE_SEARCH_API_KEY or TAVILY_API_KEY).",
          },
        },
      ],
    };
  }

  let anyBackendAnswered = false;

  for (const provider of providers) {
    const outcome = await provider.search(trimmed, opts);
    if (!outcome.ok) {
      attempts.push({ provider: provider.name, outcome: "failed", failure: outcome.failure });
      continue;
    }
    anyBackendAnswered = true;
    if (outcome.results.length === 0) {
      attempts.push({ provider: provider.name, outcome: "empty", count: 0 });
      continue;
    }
    attempts.push({ provider: provider.name, outcome: "results", count: outcome.results.length });
    return {
      status: "found",
      results: outcome.results,
      provider: provider.name,
      query: trimmed,
      attempts,
    };
  }

  return anyBackendAnswered
    ? { status: "nothing", query: trimmed, attempts }
    : { status: "could_not_look", query: trimmed, attempts };
}

/**
 * One line per backend, for a log or a health route: "searxng empty; brave 6".
 * Kept here rather than at call sites so every adopter's logs read the same.
 */
export function describeAttempts(attempts: SearchAttempt[]): string {
  return attempts
    .map((a) => {
      if (a.outcome === "results") return `${a.provider} ${a.count}`;
      if (a.outcome === "empty") return `${a.provider} empty`;
      return `${a.provider} ${a.failure?.kind ?? "failed"}`;
    })
    .join("; ");
}
