/**
 * Web module types — the three answers a lookup can give.
 *
 * The distinction this file exists to preserve: "I found nothing" and "I could
 * not look" are DIFFERENT answers, and collapsing them is how an agent comes to
 * report a confident negative it never earned. A search whose provider was
 * rate-limited returns zero results, exactly like a search for a phrase nobody
 * has ever written; if both arrive as `[]`, the model says "there is nothing
 * about X on the web" in both cases, and one of those sentences is a lie.
 *
 * So every outcome here is a tagged union with `ok`, and the failure branch
 * carries a `reason` the model is shown verbatim. Nothing in this module
 * throws — a lookup failing is an ordinary result, not an exception, because
 * the caller is an agent loop that must keep going either way.
 */

/** One result from a search engine. Snippets are the engine's, never rewritten. */
export type WebResult = {
  title: string;
  url: string;
  /** The engine's own summary of the page. May be empty. */
  snippet: string;
  /** ISO date when the engine reports one. Absent is normal, not an error. */
  published?: string;
  /** Which upstream engine surfaced it, where the provider tells us. */
  engine?: string;
};

/** Why a lookup could not be performed. Shown to the model, so phrase for reading. */
export type WebFailure =
  | { kind: "not_configured"; reason: string }
  | { kind: "rate_limited"; reason: string }
  | { kind: "auth"; reason: string }
  | { kind: "timeout"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "unreachable"; reason: string }
  | { kind: "bad_response"; reason: string };

export type SearchOutcome =
  | { ok: true; results: WebResult[]; provider: string; query: string }
  | { ok: false; failure: WebFailure; provider: string; query: string };

export type PageOutcome =
  | {
      ok: true;
      url: string;
      title: string;
      /** Readable text, tags stripped, whitespace collapsed. */
      text: string;
      /** True when `text` hit the character cap and the tail was dropped. */
      truncated: boolean;
    }
  | { ok: false; url: string; failure: WebFailure };

/**
 * A search backend. Deliberately one method: everything else a provider might
 * offer (news verticals, autocomplete, "AI answers") is a different product
 * decision and belongs to the caller, not to a seam whose whole job is to make
 * the backends interchangeable.
 */
export type SearchProvider = {
  /** Stable id used in logs, Fact sources and the chain's report: "searxng". */
  readonly name: string;
  /** False when the env it needs is absent — the chain skips it without a call. */
  configured(): boolean;
  search(query: string, opts: SearchOptions): Promise<SearchOutcome>;
};

export type SearchOptions = {
  /** Upper bound on results. Providers may return fewer; none may return more. */
  limit?: number;
  /** Per-provider deadline in milliseconds. */
  timeoutMs?: number;
  /** Restrict to one site, e.g. "docs.python.org". Applied as the engine allows. */
  site?: string;
  /** Language hint, BCP-47-ish ("en", "de-CH"). Best-effort per provider. */
  lang?: string;
};

export type ReadOptions = {
  timeoutMs?: number;
  /** Character cap on extracted text. */
  maxChars?: number;
  /** Bytes to read off the wire before giving up on an oversized document. */
  maxBytes?: number;
};

/** Env bag. Defaults to `process.env`; injectable so tests need no globals. */
export type WebEnv = Record<string, string | undefined>;
