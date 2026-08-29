/**
 * Walk a chain, never own the fetch.
 *
 * `usableChain`/`chainFrom` (chain.ts) already answer WHICH links exist and in
 * what order. What was still missing — in every app that hand-rolled it, and
 * inconsistently — is the loop that tries link one, and on failure tries link
 * two, rather than picking the first link and calling it once. A chain nobody
 * walks is a list, not a fallback: it was found sitting unused next to a
 * single-shot caller in the same app that this package's `freeChain` already
 * protected from a retired model but not from a dead key, because ordering the
 * links and walking them were still two different jobs and only one had a
 * home.
 *
 * This still ships no HTTP client. `attempt` is supplied by the caller and
 * does the actual request; this only decides which link goes next, and
 * records the outcome if a `HealthTracker` is given.
 */

import type { Link } from "./chain.js";
import type { HealthTracker } from "./health.js";

export interface ChainAttemptFailure {
  link: Link;
  message: string;
}

/** Every link in the chain was tried and failed (or the chain was empty). */
export class ChainExhaustedError extends Error {
  readonly failures: ChainAttemptFailure[];

  constructor(failures: ChainAttemptFailure[]) {
    super(
      failures.length === 0
        ? "No usable link in the chain — every provider is missing its key, or has no models configured."
        : `All ${failures.length} link(s) failed — ${failures
            .map((f) => `${f.link.provider.id}/${f.link.model}: ${f.message}`)
            .join("; ")}`,
    );
    this.name = "ChainExhaustedError";
    this.failures = failures;
  }
}

export interface TryChainOptions<T> {
  /** Makes the actual call for one link. Throw to demote to the next link. */
  attempt: (link: Link) => Promise<T>;
  /** Records one success or one failure for the WHOLE walk, not per link. */
  health?: HealthTracker;
  /** Called on each link's failure, before moving to the next — e.g. to log it. */
  onLinkFailure?: (link: Link, error: unknown) => void;
}

/**
 * Try each link in order; return the first success.
 *
 * Health is recorded once per call — a success on link two is still a success
 * for the app, and a health check that flagged it "degraded" because the FIRST
 * link failed would be reporting its own fallback working as a problem.
 *
 * Throws `ChainExhaustedError` (carrying every link's failure) when none
 * succeed, so a caller can log exactly what was tried rather than only the
 * last error — the failure that matters is often not the last one.
 */
export async function tryChain<T>(chain: Link[], options: TryChainOptions<T>): Promise<T> {
  const failures: ChainAttemptFailure[] = [];

  for (const link of chain) {
    try {
      const result = await options.attempt(link);
      options.health?.recordSuccess();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ link, message });
      options.onLinkFailure?.(link, error);
    }
  }

  const exhausted = new ChainExhaustedError(failures);
  options.health?.recordFailure(exhausted);
  throw exhausted;
}
