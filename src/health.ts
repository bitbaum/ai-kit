/**
 * Observed health of an AI feature — was the last generation actually usable?
 *
 * This exists because of a failure that "the chain never fails" hides just as
 * well as a single pin does. On 2026-08-28 an app's only configured key
 * started returning 401 and the chain (correctly) had nowhere else to go — the
 * routes caught the error and answered HTTP 200 with an apology, and the
 * app's own `/health` reported "healthy" because it only ever checked the
 * database. A total outage of the product's core feature was invisible to
 * every automated check, for as long as nobody happened to try it by hand.
 *
 * A tracker records what actually happened, so a health route can report it
 * and a strict check can refuse to call the app "up" while its AI is down.
 *
 * FACTORY, NOT A SINGLETON. A module-level global would force a shared state
 * shape on every consumer and make the transitions untestable without mutating
 * process-wide state between tests. `createHealthTracker()` returns an
 * isolated instance — a single-process app gets the old singleton behaviour
 * for free by creating exactly one and exporting it from its own module:
 *
 *     // lib/llm-health.ts
 *     export const llmHealth = createHealthTracker();
 *
 * If the app scales horizontally, this state is per-instance and wants a
 * shared store — that migration is app-specific and out of scope here.
 */

export type HealthStatus = "unknown" | "ok" | "degraded" | "down";

export interface Health {
  status: HealthStatus;
  consecutiveFailures: number;
  lastError: string | null;
  /** Epoch milliseconds. Format at the API boundary, not here. */
  lastSuccessAt: number | null;
  /** Epoch milliseconds. Format at the API boundary, not here. */
  lastFailureAt: number | null;
}

export interface HealthTrackerOptions {
  /** Consecutive failures before status flips from "degraded" to "down". Default 3. */
  downAfter?: number;
  /** Clock injection point for tests. Default `Date.now`. */
  now?: () => number;
}

export interface HealthTracker {
  /** Call after a generation that produced usable content. */
  recordSuccess(): void;
  /** Call when generation threw, or returned nothing usable. */
  recordFailure(error: unknown): void;
  getHealth(): Health;
  /** Test seam — also useful for an app-triggered "recheck now". */
  reset(): void;
}

export function createHealthTracker(options: HealthTrackerOptions = {}): HealthTracker {
  const downAfter = options.downAfter ?? 3;
  const now = options.now ?? Date.now;

  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;

  return {
    recordSuccess() {
      consecutiveFailures = 0;
      lastError = null;
      lastSuccessAt = now();
    },
    recordFailure(error: unknown) {
      consecutiveFailures += 1;
      lastFailureAt = now();
      lastError = error instanceof Error ? error.message : String(error ?? "unknown error");
    },
    getHealth(): Health {
      let status: HealthStatus;
      if (consecutiveFailures >= downAfter) status = "down";
      else if (consecutiveFailures > 0) status = "degraded";
      else if (lastSuccessAt !== null) status = "ok";
      else status = "unknown";
      return { status, consecutiveFailures, lastError, lastSuccessAt, lastFailureAt };
    },
    reset() {
      consecutiveFailures = 0;
      lastError = null;
      lastSuccessAt = null;
      lastFailureAt = null;
    },
  };
}
