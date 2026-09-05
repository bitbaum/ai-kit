/**
 * ai-kit — one install for the AI layer of an app.
 *
 * WHAT IT IS FOR
 * --------------
 * An app that wants an AI feature needs several unrelated-looking decisions to
 * go right, and getting any one wrong looks identical from the outside: the
 * assistant is broken. This package holds all of them, so adding AI is one
 * decision instead of many.
 *
 *   which model  — a fallback list ACROSS VENDORS, because a single pinned free
 *                  model is a scheduled outage, and a smaller model at the same
 *                  vendor draws on the same exhausted daily budget.
 *   still there? — has the vendor retired an id we still ask for? The list is
 *                  itself a list of pins, so it rots too. Zero tokens, so it can
 *                  run on a schedule instead of being remembered.
 *   walk it      — a chain nobody walks is a list, not a fallback. `tryChain`
 *                  tries each link and stops at the first success; a
 *                  `HealthTracker` records whether the WHOLE chain came back
 *                  empty, so a health route can say so before a user does.
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
 * NOW INCLUDED: an HTTP client. `complete()` makes the call.
 *
 * The old rule was "every app has its own calling conventions, and replacing
 * those is a rewrite rather than an adoption" — accurate about the fleet, and
 * it protected the very duplication it described. The conventions differed
 * because nothing ever offered to own them. Measured 2026-09-05: 8 hand-rolled
 * clients in service, 2 of which tell the three kinds of 429 apart, while this
 * package explained the distinction to the 2 repos that imported it.
 * `ai-forms` — adopted by 5 — is not better code, it is code that does the job
 * rather than advising on it. See `complete.ts` for the full argument.
 *
 * `tryChain` remains for a caller with a genuinely unusual request to make: it
 * walks the chain and lets the caller keep the fetch. `complete` is the answer
 * for everyone else.
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
  type ChainAttemptFailure,
  type TryChainOptions,
  ChainExhaustedError,
  tryChain,
} from "./attempt.js";

export {
  type ChatMessage,
  type ToolCall,
  type CompleteOptions,
  type CompleteResult,
  LinkFailure,
  complete,
  linkId,
} from "./complete.js";

export {
  type HealthStatus,
  type Health,
  type HealthTrackerOptions,
  type HealthTracker,
  createHealthTracker,
} from "./health.js";

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
//     import { freeChain } from "@bitbaum/ai-kit";          // the chain
//     import { defineFields } from "@bitbaum/ai-kit/forms"; // form filling
//     import { useAssist } from "@bitbaum/ai-kit/react";    // the React hook
//
// Same dependency, same version, nothing extra to install — a consumer just
// stops paying for the half it does not use. That is what subpath exports are
// for, and collapsing them into the root threw the benefit away.
