/**
 * Can this deployment reach a model RIGHT NOW?
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * A health route that reports `createHealthTracker().getHealth()` reports what
 * happened the last time the app happened to call a model. Straight after a
 * deploy that is `"unknown"` — no calls yet — and "unknown" is what it stays
 * until real traffic arrives. So the one question a deploy needs answered ("did
 * I just ship a working AI path?") is exactly the one it cannot answer.
 *
 * Observed 2026-09-05, converting the first app to `complete()`: the deploy was
 * green, the bundle provably contained the new code, both keys were present,
 * `/api/health` returned 200 — and `llm.status` was `"unknown"`. Every signal
 * available said "probably fine". The only paths that would have produced a
 * real answer were an admin-authenticated form and two cron jobs that EMAIL
 * REAL USERS. Verifying a deploy must never require spamming somebody.
 *
 * ── Why it is a probe and not a passive read ─────────────────────────────────
 * Absence of failure is not evidence of success. A tracker that has recorded
 * nothing looks identical whether the chain is perfect or every key is missing.
 * The only thing that distinguishes them is making a call — so this makes one,
 * deliberately, on demand.
 *
 * ── Why it must be gated and cached ──────────────────────────────────────────
 * This spends real tokens from a free daily budget shared across the whole org.
 * An ungated probe on a health route is a self-inflicted outage: a monitor
 * polling every 30s would drain a 100k/day allowance and take the app's actual
 * AI features down with it. So:
 *
 *   - a probe runs ONLY when asked for explicitly (`?probe=1`) AND the caller
 *     proves it is allowed to (a secret), never on an ordinary health poll;
 *   - a successful probe is CACHED for `minIntervalMs` (default 10 minutes),
 *     so even an authorised caller in a retry loop cannot burn the budget. The
 *     cached answer is returned with `cached: true` and the age, because a
 *     nine-minute-old success is a different claim from a fresh one and the
 *     reader deserves to know which they got.
 *
 * The prompt is deliberately tiny — a handful of tokens — because the question
 * is "does the pipe carry water", not "is the model any good".
 */

import { complete, type CompleteOptions } from "./complete.js";
import type { Link } from "./chain.js";
import { ChainExhaustedError } from "./attempt.js";
import type { HealthTracker } from "./health.js";

export interface LivenessResult {
  /** Did a model answer? */
  ok: boolean;
  /** `provider/model` that served it, when one did. */
  servedBy?: string;
  /** What the model actually said, trimmed — proof of a real generation, not a 200. */
  answer?: string;
  /** Round-trip milliseconds for a fresh probe. */
  ms?: number;
  /** True when this is a remembered result rather than a call made just now. */
  cached: boolean;
  /** Age of a cached result, in milliseconds. */
  cachedAgeMs?: number;
  /** Every link's failure, when the whole chain was exhausted. */
  failures?: string[];
  /** Why no call was attempted at all (no keys, no links). */
  skipped?: string;
}

export interface LivenessOptions extends Omit<
  CompleteOptions,
  "messages" | "maxTokens" | "temperature"
> {
  /**
   * Don't call again within this window; return the last successful result.
   * Default 10 minutes. Set 0 to disable caching — only for a test.
   */
  minIntervalMs?: number;
  /**
   * Resolve the chain when a probe actually runs, rather than once at
   * construction.
   *
   * For an app whose provider list lives in a DATABASE — an admin screen with
   * enabled/default rows and per-provider keys — a chain fixed at construction
   * is a chain frozen at process start. The probe would then keep reporting on
   * a configuration the operator changed twenty minutes ago, which is the
   * opposite of "the truth about right now".
   *
   * It is called only on a real probe, never on a cache hit, so a monitor
   * polling this route does not also poll the database.
   *
   * Takes precedence over `chain` when both are given.
   */
  resolveChain?: () => Link[] | Promise<Link[]>;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The budget the probe asks for.
 *
 * NOT small, despite the tiny prompt. The chain leads with REASONING models,
 * which spend this on hidden thinking before emitting a visible token: measured
 * 2026-09-05, groq/openai/gpt-oss-20b answered EMPTY at 16 and correctly at 256
 * for the same one-word question. An empty completion is a failure here (see
 * complete.ts), so a mean budget would make a perfectly healthy deployment
 * report itself dead — the exact false alarm this module exists to prevent.
 */
const PROBE_MAX_TOKENS = 256;

/**
 * Tighter than `complete`'s 30s default, per link.
 *
 * A monitor asking "is the AI up?" gives up long before a chain of 30-second
 * links has finished being patient — and a health route that takes a minute to
 * answer "down" has not answered at all, it has just become a second outage.
 * Ten seconds is far above the ~1s a healthy free-tier link measures.
 */
const PROBE_TIMEOUT_MS = 10_000;

/** A question with one short right answer, cheap to ask and easy to sanity-check. */
const PROBE_MESSAGES = [
  { role: "system" as const, content: "Answer with a single word, no punctuation." },
  { role: "user" as const, content: "What colour is a clear midday sky? Answer in one word." },
];

export interface LivenessProbe {
  /** Make a call (or return a cached success). */
  run(): Promise<LivenessResult>;
  /** Forget any cached success — the next `run` will really call. */
  reset(): void;
}

/**
 * Build a probe with its own cache.
 *
 * The cache lives on the instance rather than in a module global so that two
 * apps in one process, or a test, cannot silently share (and satisfy) each
 * other's probe.
 */
export function createLivenessProbe(options: LivenessOptions = {}): LivenessProbe {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let lastOk: { at: number; result: LivenessResult } | null = null;

  return {
    reset() {
      lastOk = null;
    },

    async run(): Promise<LivenessResult> {
      if (lastOk && minIntervalMs > 0) {
        const age = now() - lastOk.at;
        if (age < minIntervalMs) {
          return { ...lastOk.result, cached: true, cachedAgeMs: age };
        }
      }

      const started = now();
      try {
        // Resolved here, not at construction, and only on a real probe — so a
        // monitor polling this route does not also poll whatever backs it.
        const chain = options.resolveChain ? await options.resolveChain() : options.chain;

        const result = await complete({
          timeoutMs: PROBE_TIMEOUT_MS,
          ...options,
          chain,
          messages: PROBE_MESSAGES,
          maxTokens: PROBE_MAX_TOKENS,
          temperature: 0,
        });

        const answer = result.text.trim();
        const fresh: LivenessResult = {
          ok: true,
          servedBy: result.id,
          answer,
          ms: now() - started,
          cached: false,
        };
        lastOk = { at: now(), result: fresh };
        return fresh;
      } catch (error) {
        // A failure is deliberately NOT cached. Caching it would keep reporting
        // an outage after the vendor recovered, and the whole point is to tell
        // the truth about right now.
        if (error instanceof ChainExhaustedError) {
          return {
            ok: false,
            cached: false,
            ms: now() - started,
            failures: error.failures.map((f) => f.message),
            ...(error.failures.length === 0
              ? { skipped: "No usable link — every provider is missing its key or has no models." }
              : {}),
          };
        }
        return {
          ok: false,
          cached: false,
          ms: now() - started,
          failures: [error instanceof Error ? error.message : String(error)],
        };
      }
    },
  };
}

export interface AiHealthHandlerOptions extends LivenessOptions {
  /**
   * Shared secret authorising a probe. Compared against the `x-probe-secret`
   * header or a `secret` query parameter.
   *
   * When absent, the handler NEVER probes — it only reports passive health.
   * That default is deliberate: an app that forgets to configure a secret gets
   * a route that cannot spend money, rather than an open endpoint that can.
   */
  secret?: string;
  /** Passive health to report alongside. Optional. */
  health?: HealthTracker;
}

/**
 * A framework-neutral `Request -> Response` handler for an AI health route.
 *
 * Web-standard on purpose: Next's App Router, Hono, Deno and Bun all accept
 * this shape directly, so adopting it is an export line rather than a port.
 *
 *   GET /api/health/ai              passive — what happened last time. Free.
 *   GET /api/health/ai?probe=1      makes a real call. Requires the secret.
 *
 * A probe without a valid secret is 401 and does NOT fall back to probing.
 *
 * Status codes are chosen so an uptime monitor can watch this URL directly:
 * 200 when the answer is good, 503 when a probe was attempted and the chain
 * could not answer.
 */
export function createAiHealthHandler(
  options: AiHealthHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const { secret, health, ...probeOptions } = options;
  const probe = createLivenessProbe(probeOptions);

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const wantsProbe = url.searchParams.get("probe") === "1";
    const offered =
      request.headers.get("x-probe-secret") ?? url.searchParams.get("secret") ?? undefined;

    const passive = health ? { health: health.getHealth() } : {};

    if (!wantsProbe) {
      return json(200, { probed: false, ...passive });
    }

    // No secret configured means probing is switched off, which is a different
    // answer from "your secret is wrong" — say so, rather than implying the
    // caller could retry with a better credential.
    if (!secret) {
      return json(501, {
        probed: false,
        error: "Probing is not configured on this deployment (no secret set).",
        ...passive,
      });
    }
    if (!offered || !timingSafeEqual(offered, secret)) {
      return json(401, { probed: false, error: "Bad or missing probe secret.", ...passive });
    }

    const result = await probe.run();
    // Record into passive health too, so one probe also answers the next
    // ordinary health poll — otherwise the probe's knowledge dies with it.
    if (health) {
      if (result.ok) health.recordSuccess();
      else health.recordFailure(new Error(result.failures?.join("; ") ?? "probe failed"));
    }
    return json(result.ok ? 200 : 503, {
      probed: true,
      ...result,
      ...(health ? { health: health.getHealth() } : {}),
    });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Constant-time comparison, so a wrong secret cannot be discovered one
 * character at a time by timing the 401.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
