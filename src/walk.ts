/**
 * Walking the chain, once, for every caller that walks it.
 *
 * `complete()` and `completeStream()` must agree about what a dead vendor is,
 * or the fleet ends up with two answers to "is this provider out of budget"
 * and the streaming path — the one every chat surface uses — is the one that
 * gets it wrong. The rules here are not new; they were extracted from
 * `complete()` unchanged, and its test suite is what proves they survived.
 */
import { type Env, type Link, type Provider, chainFrom, freeChain, usableChain } from "./chain.js";
import { ChainExhaustedError, type ChainAttemptFailure } from "./attempt.js";
import { LinkFailure, linkId } from "./complete.js";
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

    try {
      const result = await attempt(link, key);
      options.health?.recordSuccess();
      return result;
    } catch (error) {
      const failure = error as LinkFailure;
      // Not a link failure: a programming error in the caller's handler, or an
      // abort. Reporting it as "every vendor failed" would send whoever reads
      // the log looking for an outage at someone else's shop.
      if (!(error instanceof LinkFailure)) throw error;

      failures.push({ link, message: failure.message });
      options.onLinkFailure?.(link, failure);

      if (failure.kind === "daily") deadProviders.add(link.provider.id);

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

  const exhausted = new ChainExhaustedError(failures);
  options.health?.recordFailure(exhausted);
  throw exhausted;
}
