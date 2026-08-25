/**
 * ai-ration — keep an LLM app on free tiers, and share what is free fairly.
 *
 * Four pieces that each solve a distinct failure, and are useful separately:
 *
 *   chain      — a fallback list ACROSS VENDORS, because a single pinned free
 *                model is a scheduled outage and a smaller model at the same
 *                vendor draws on the same exhausted daily budget.
 *   catalog    — has the vendor retired an id the chain still asks for? The
 *                chain is itself a list of pins, so it rots too; on 2026-08-25
 *                four of nine default ids were already gone, including an
 *                entire vendor. Zero tokens, so it can run on a schedule.
 *   limits     — tell the three kinds of 429 apart, because they need opposite
 *                responses and only the body distinguishes them.
 *   fair-share — divide a fixed daily pool across active users so the person who
 *                arrives at 4pm still gets a turn.
 *
 * Deliberately NOT included: an HTTP client. Every app here already has its own
 * calling conventions, retries, and logging, and replacing those is a rewrite
 * rather than an adoption. This package supplies the decisions; the caller keeps
 * the fetch.
 */

export {
  type Provider,
  type Env,
  type Link,
  type CostVerdict,
  providerModels,
  withEnvPrefix,
  freeChain,
  modelCost,
  modelCostAt,
  paidModelsIn,
  dayCapacityTokens,
  usableChain,
  chainFrom,
} from "./chain.js";

export {
  type CatalogVerdict,
  type CheckCatalogOptions,
  checkCatalog,
  hasRot,
  deadProviders,
  catalogReport,
} from "./catalog.js";

export {
  type RateLimitKind,
  classifyRateLimit,
  retryAfterSeconds,
  humanizeWait,
  rateLimitMessage,
} from "./limits.js";

export {
  DAY_SECONDS,
  DEFAULT_BURST,
  type ShareInput,
  type ShareReason,
  type ShareDecision,
  fairShare,
  utcDayElapsed,
  utcDayKey,
} from "./fair-share.js";
