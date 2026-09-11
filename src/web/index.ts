/**
 * ai-kit/web — the agent's eyes on the open web.
 *
 * Why this belongs in this package rather than in each app. Every AI product
 * in the fleet is about to need the same four things, and each one is a
 * distinct way to be wrong:
 *
 *   1. WHICH backend. Self-hosted metasearch, an independent index, an
 *      agent-oriented API — with the same fallback-chain problem `chain.ts`
 *      already solved for models, for the same reason: a single pinned
 *      backend is a scheduled outage.
 *   2. WHETHER it answered. "Found nothing" and "could not look" are different
 *      answers, and an app that collapses them ships confident negatives it
 *      never earned.
 *   3. Fetching a page an AGENT chose, which is a genuinely different security
 *      problem from fetching one a user typed — the model can be steered to a
 *      URL by any page it reads, so the SSRF guard has to survive redirects and
 *      DNS rebinding rather than checking a string once.
 *   4. CITATIONS. Search without citation binding makes hallucination worse,
 *      because now the invented sentence is surrounded by real ones.
 *
 * Four chances to get it wrong, times every app, is the duplication this
 * package exists to end. The output type is deliberately `Fact` from
 * `ai-kit/grounding` rather than a bespoke shape: retrieved web content and
 * retrieved database rows then flow through ONE verifier, and "cite your
 * sources" becomes a mechanical check instead of a line in a prompt.
 *
 * What it deliberately does not do: summarise, re-rank with an LLM, crawl,
 * render JavaScript, or cache. The first two are the model's job and belong
 * upstream where the app's own prompt lives; the last three are a different
 * product with a different cost profile.
 */
export type {
  WebResult,
  WebFailure,
  SearchOutcome,
  PageOutcome,
  SearchProvider,
  SearchOptions,
  ReadOptions,
  WebEnv,
} from "./types.js";

export {
  webSearch,
  describeAttempts,
  type WebSearchResult,
  type SearchAttempt,
  type WebSearchDeps,
} from "./search.js";

export { searxngProvider, braveProvider, tavilyProvider, defaultProviders } from "./providers.js";

export { readPage, extractReadableText, type ReadDeps, type ExtractedPage } from "./read.js";

export {
  validateFetchTarget,
  isPrivateAddress,
  defaultLookup,
  type LookupFn,
  type UrlVerdict,
} from "./ssrf.js";

export {
  resultsToFacts,
  pageToFact,
  resultsEvidence,
  pageEvidence,
  describeEmptySearch,
} from "./facts.js";
