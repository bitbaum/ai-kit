/**
 * Walking the chain, once, for every caller that walks it.
 *
 * `complete()` and `completeStream()` must agree about what a dead vendor is,
 * or the fleet ends up with two answers to "is this provider out of budget"
 * and the streaming path — the one every chat surface uses — is the one that
 * gets it wrong. The rules here are not new; they were extracted from
 * `complete()` unchanged, and its test suite is what proves they survived.
 */
import {
  checkSpend,
  isPaidProvider,
  recordSpend,
  spendApp,
  SpendLimitError,
  type SpendRefusal,
} from "./spend.js";
import {
  type Env,
  type Link,
  type Provider,
  chainFrom,
  freeChain,
  healthFor,
  usableChain,
} from "./chain.js";
import { ChainExhaustedError, type ChainAttemptFailure } from "./attempt.js";
import { LinkFailure, linkId } from "./complete.js";
import { emitUsage, usageEventFor } from "./usage-log.js";
import { namesModel } from "./limits.js";
import type { HealthTracker } from "./health.js";

/**
 * What the walk itself needs, which is less than any one caller passes.
 *
 * `CompleteOptions` satisfies this structurally and did not have to change —
 * the point of naming the subset is that a caller with a DIFFERENT payload can
 * reuse the routing. `transcribe()` sends audio rather than messages, and
 * without this it would have had to fake a `messages` field to borrow the walk,
 * or copy thirty lines of "is this vendor dead" logic that must not be allowed
 * to have two answers.
 */
export interface WalkOptions {
  /** Links to try, in order. Defaults to every free provider with a key. */
  chain?: Link[];
  providers?: Provider[];
  /** Start at this model rather than the front, falling through to the rest. */
  model?: string;
  env?: Env;
  health?: HealthTracker;
  /** The caller's cancellation, covering the whole walk. */
  signal?: AbortSignal;
  onLinkFailure?: (link: Link, error: Error) => void;
  /**
   * The app this call spends for (./spend): its paid caps and opt-in. Unset:
   * the provider's env prefix (withEnvPrefix), then AI_APP_ID.
   */
  app?: string;
  /** Input tokens this call will send, for the paid caps' token check. */
  estimateInputTokens?: number;
}

/**
 * Try each link until one works, and return what it produced.
 *
 * `attempt` owns the request. Throwing `LinkFailure` from it means "this link
 * did not serve the turn" and the walk continues; anything else propagates,
 * because a bug in the caller's own code is not a vendor outage.
 *
 * Throws `ChainExhaustedError` carrying every link's failure, so a log shows
 * what was actually tried — the failure that explains an outage is usually not
 * the last one.
 */
/**
 * The links this walk will actually try, in order, before any of them is
 * called.
 *
 * Exported because a caller sometimes has to DECIDE something about the chain
 * rather than merely walk it — `complete()` drops the links that cannot read
 * an image. Resolving the same defaults twice, in two files, is how the
 * routing quietly grows a second opinion; this is the one resolution.
 *
 * NOT `resolveChain` — that name is taken by `resolve.ts`, which answers a
 * different question (what does the vendor's live CATALOGUE offer). Two
 * functions called `resolveChain` in one package would be a coin flip at every
 * import site.
 */
/** Tokens a completed call reports (an OpenAI-shaped `usage`), when it does. */
function usageOf(result: unknown): { input: number; output: number } | null {
  const usage = (result as { raw?: { usage?: Record<string, unknown> } } | null)?.raw?.usage;
  if (!usage) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(usage.prompt_tokens), output: n(usage.completion_tokens) };
}

export function walkLinks(options: WalkOptions): Link[] {
  const env = options.env ?? process.env;
  const base = options.chain ?? usableChain(options.providers ?? freeChain(), env);
  return chainFrom(options.model, base);
}

export async function walkChain<T>(
  options: WalkOptions,
  attempt: (link: Link, key: string) => Promise<T>,
): Promise<T> {
  const env = options.env ?? process.env;
  const chain = walkLinks(options);

  const failures: ChainAttemptFailure[] = [];
  const deadProviders = new Set<string>();

  // The spend rules (./spend): paid off unless opted in, daily caps, the free
  // loop guard. A cap that is reached is not walked around onto another paid
  // vendor: once one paid link is refused, the rest of the paid links are too.
  const refusals: Array<{ message: string; reason: SpendRefusal }> = [];
  let paidStopped = false;
  let attempted = 0;

  for (const link of chain) {
    // A daily cap already condemned this vendor earlier in the walk. Its other
    // models draw on the same exhausted budget, so trying them buys a dead
    // round trip and the identical error.
    if (deadProviders.has(link.provider.id)) continue;

    const key = env[link.provider.keyEnv]?.trim();
    if (!key) {
      failures.push({ link, message: `${linkId(link)}: no ${link.provider.keyEnv} in env` });
      continue;
    }

    const app = spendApp(link, options.app, env);
    if (paidStopped && isPaidProvider(link.provider)) continue;
    const verdict = checkSpend(link, app, env, { estimateIn: options.estimateInputTokens });
    if (!verdict.ok) {
      refusals.push({ message: verdict.message, reason: verdict.reason });
      failures.push({ link, message: verdict.message });
      console.warn(`[ai-kit] ${verdict.message}`);
      emitUsage(
        usageEventFor(link, app, isPaidProvider(link.provider), {
          outcome: "refused",
          reason: verdict.reason,
        }),
        env,
      );
      if (isPaidProvider(link.provider)) paidStopped = true;
      continue;
    }
    recordSpend(verdict.scopes, { calls: 1 });
    attempted++;
    const startedAt = Date.now();

    try {
      const result = await attempt(link, key);
      (link.provider.byok ? undefined : options.health)?.recordSuccess();
      const usage = usageOf(result);
      emitUsage(
        usageEventFor(link, app, verdict.paid, {
          outcome: "served",
          ms: Date.now() - startedAt,
          ...(usage ? { inputTokens: usage.input, outputTokens: usage.output } : {}),
        }),
        env,
      );
      if (verdict.paid) {
        recordSpend(verdict.scopes, {
          inputTokens: usage?.input ?? options.estimateInputTokens ?? 0,
          outputTokens: usage?.output ?? 0,
        });
      }
      return result;
    } catch (error) {
      const failure = error as LinkFailure;
      // Not a link failure: a programming error in the caller's handler, or an
      // abort. Reporting it as "every vendor failed" would send whoever reads
      // the log looking for an outage at someone else's shop.
      if (!(error instanceof LinkFailure)) throw error;

      emitUsage(
        usageEventFor(link, app, verdict.paid, {
          outcome: "failed",
          ms: Date.now() - startedAt,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          ...(failure.kind ? { kind: failure.kind } : {}),
        }),
        env,
      );
      failures.push({ link, message: failure.message });
      options.onLinkFailure?.(link, failure);

      // …unless the refusal names THIS model. Groq meters its day per model:
      // measured 2026-09-25, gpt-oss-20b refused "for model `openai/gpt-oss-20b`
      // … tokens per day" while gpt-oss-120b on the same key served in the same
      // minute. A refusal scoped to one model condemns that link, not the vendor.
      if (failure.kind === "daily" && !namesModel(failure.message, link.model))
        deadProviders.add(link.provider.id);

      // A REJECTED KEY is a verdict about the VENDOR, not the model.
      //
      // 401/403 says "not you". Every remaining link at this provider presents
      // the identical credential, so walking them spends a request each to be
      // told the same thing. Crossing to the NEXT vendor still happens: that is
      // a different key, and the whole reason the chain spans vendors.
      //
      // Deliberately narrow. A 404 is a retired id, a 5xx is a vendor being
      // unwell, a capacity 429 is a busy minute — all three are answered by
      // asking a different model, and widening this skip to cover them would
      // quietly turn the chain back into the pin it replaced.
      if (failure.status === 401 || failure.status === 403) {
        deadProviders.add(link.provider.id);
      }

      // The caller cancelled — the request they were waiting on is gone.
      if (options.signal?.aborted) break;

      // Stepping down after a size 429 reaches a model with a smaller ceiling —
      // strictly worse. Stop, and let the caller shorten the prompt.
      if (failure.kind === "size") break;
    }
  }

  // Nothing was called: every usable link was refused by the spend rules.
  // Said as what it is, not as a vendor outage.
  if (attempted === 0 && refusals.length > 0) {
    throw new SpendLimitError(
      refusals.map((r) => r.message),
      refusals.map((r) => r.reason),
    );
  }

  const exhausted = new ChainExhaustedError(failures);
  healthFor(chain, options.health)?.recordFailure(exhausted);
  throw exhausted;
}
