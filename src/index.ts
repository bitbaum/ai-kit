/**
 * ai-kit — one install for the AI layer of an app.
 *
 * WHAT IT IS FOR
 * --------------
 * An app that wants an AI feature needs four unrelated-looking decisions to go
 * right, and getting any one wrong looks identical from the outside: the
 * assistant is broken. This package holds all four, so adding AI is one
 * decision instead of four.
 *
 *   which model  — a fallback list ACROSS VENDORS, because a single pinned free
 *                  model is a scheduled outage, and a smaller model at the same
 *                  vendor draws on the same exhausted daily budget.
 *   still there? — has the vendor retired an id we still ask for? The list is
 *                  itself a list of pins, so it rots too. Zero tokens, so it can
 *                  run on a schedule instead of being remembered.
 *   too fast?    — tell the three kinds of 429 apart. They share a status code
 *                  and need opposite responses; only the body distinguishes them.
 *   who gets it  — divide a fixed daily pool across active users, so the person
 *                  who arrives at 4pm still gets a turn.
 *   filling forms— fill a form from prose and keep talking to it, re-exported
 *                  from `ai-forms` (see ./forms.ts for why it stays separate).
 *
 * WHY IT WAS RENAMED FROM ai-ration
 * ---------------------------------
 * Because the owner of this fleet read the name and could not tell what it did.
 * That is not a cosmetic complaint: an unreadable name is an adoption cost paid
 * on every single install decision, and this package had ONE adopter while the
 * five repos that skipped it were all taken down together on 2026-08-26 by a
 * retired model id — the exact failure the `chain` and `catalog` modules exist
 * to prevent. "Ration" described one of five modules and buried the other four.
 *
 * STILL NOT INCLUDED: an HTTP client. Every app has its own calling conventions,
 * retries and logging, and replacing those is a rewrite rather than an adoption.
 * This supplies the decisions; the caller keeps the fetch. That rule is under
 * review — `ai-forms`, the most-adopted package in this fleet, is the one that
 * broke it by shipping a route factory and a hook.
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

// Form filling lives at `ai-kit/forms`, NOT here.
//
// It was re-exported from this root for one release, so that "adding AI" was a
// single import as well as a single install. The first app to adopt the merged
// package showed what that costs: `ai-forms` is ESM-only, so pulling it in from
// this root made every consumer of the CHAIN load the forms package too — and
// the app's Jest run, which executes CJS, died on `Unexpected token 'export'`
// inside a module it never asked for. The fix would have been a
// `transformIgnorePatterns` entry in that app, and in the next one, and in
// every app thereafter: one class of breakage, paid per repo, forever.
//
// One install is still the promise, and the exports map already keeps it:
//
//     import { freeChain } from "ai-kit";          // the chain
//     import { defineFields } from "ai-kit/forms"; // form filling
//     import { useAssist } from "ai-kit/react";    // the React hook
//
// Same dependency, same version, nothing extra to install — a consumer just
// stops paying for the half it does not use. That is what subpath exports are
// for, and collapsing them into the root threw the benefit away.

