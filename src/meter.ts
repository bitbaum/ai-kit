/**
 * What is left at the vendor, read from the answer you already got.
 *
 * ── WHY THIS IS NOT A POLLER ─────────────────────────────────────────────────
 *
 * The obvious design is to ask each provider how much quota remains. That
 * design is wrong, and it is wrong in the direction that hurts: it reports a
 * full tank during an outage.
 *
 * Measured on 2026-09-11, on one live key, within the same second:
 *
 *   GET /api/v1/key        →  limit_remaining: null,  usage_daily: 0
 *   POST /chat/completions →  429, x-ratelimit-remaining: 0 of 50,
 *                             "Rate limit exceeded: free-models-per-day"
 *
 * Both answers are from OpenRouter about the same account. The account was
 * locked out. The usage endpoint tracks money, free models cost nothing, and
 * the limit that actually binds is a REQUEST count that endpoint never reports.
 * A dashboard built on the first line would have shown an untouched allowance
 * while every call was failing.
 *
 * So the meter reads the headers on calls you were making anyway. No extra
 * request, no extra quota spent to find out how much quota is left, and the
 * number comes from the same exchange that either worked or did not.
 *
 * ── THE THREE STATES ─────────────────────────────────────────────────────────
 *
 * A provider you have not called today reports NOTHING, and that is a third
 * state — not zero, not full. This module never invents a reading: no header,
 * no `QuotaReading`. Callers must render the absence as "unknown", because
 * drawing it as full repeats the bug above and drawing it as empty invents an
 * outage.
 *
 * ── VENDORS DISAGREE ABOUT WHAT THEIR OWN HEADERS MEAN ───────────────────────
 *
 * `x-ratelimit-remaining-requests` is a per-DAY count at Groq and a per-MINUTE
 * count elsewhere. The window is therefore read from a per-provider profile
 * where one is known, from the header name where it says so (`...-day`), and
 * otherwise reported as "unknown" rather than guessed. A confident wrong window
 * turns "you have 900 requests left today" into "…this minute", which is the
 * kind of error nobody catches until the dashboard has been trusted for a week.
 */

import type { Link } from "./chain.js";

/** What is being counted. */
export type QuotaScope = "requests" | "tokens";

/** The period the count refreshes over. `unknown` is a real answer. */
export type QuotaWindow = "minute" | "day" | "unknown";

/** One observation of one vendor counter, at one moment. */
export interface QuotaReading {
  /** Provider id, e.g. "groq". */
  provider: string;
  /** The model the call named — Groq meters per model, so this matters. */
  model: string;
  scope: QuotaScope;
  window: QuotaWindow;
  /** The ceiling, when the vendor states it. */
  limit: number | null;
  /** What is left. The number this module exists to obtain. */
  remaining: number;
  /** When the counter refills, epoch ms. Null when the vendor did not say. */
  resetAt: number | null;
  /** The header (or body) this came from — so a wrong number is traceable. */
  source: string;
  /** Epoch ms. A reading is evidence about a moment, not a standing fact. */
  observedAt: number;
}

/** Anything header-shaped. Keeps this module free of a DOM/undici dependency. */
export interface HeaderBag {
  get(name: string): string | null;
}

/**
 * Per-provider correction for headers whose name does not state their window.
 *
 * Only entries verified against the vendor's own documentation or a live
 * response belong here. An unlisted provider yields `unknown`, which is the
 * honest answer and renders as such.
 */
const PROVIDER_WINDOWS: Record<string, Partial<Record<QuotaScope, QuotaWindow>>> = {
  // Verified live 2026-09-11: `x-ratelimit-remaining-requests` counts the DAY
  // (1,000 per day), while `-tokens` counts the minute (8,000 per minute).
  // Reading both as per-minute understates the day by three orders of
  // magnitude; reading both as daily hides the limit that actually throttles.
  groq: { requests: "day", tokens: "minute" },
  // Verified live 2026-09-11: the unpaid tier is 50 REQUESTS per day, and the
  // bare `x-ratelimit-remaining` on the chat response is that counter.
  openrouter: { requests: "day" },
  // Documented per-minute, with separate `-day` twins this parser reads by name.
  sambanova: { requests: "minute" },
  ovh: { requests: "minute" },
  mistral: { requests: "minute" },
};

/**
 * Header names carrying a remaining count, most specific first.
 *
 * Order matters: `...-requests-day` must be tested before `...-requests`, or
 * the day counter is read as the minute counter under the shorter name.
 */
const REMAINING_HEADERS: Array<{ name: string; scope: QuotaScope; window?: QuotaWindow }> = [
  { name: "x-ratelimit-remaining-requests-day", scope: "requests", window: "day" },
  { name: "x-ratelimit-remaining-tokens-day", scope: "tokens", window: "day" },
  { name: "x-ratelimit-remaining-requests-minute", scope: "requests", window: "minute" },
  { name: "x-ratelimit-remaining-minute", scope: "requests", window: "minute" },
  { name: "x-ratelimit-remaining-requests", scope: "requests" },
  { name: "x-ratelimit-remaining-tokens", scope: "tokens" },
  // Bare forms. OpenRouter uses `x-ratelimit-remaining`; OVHcloud drops the
  // `x-` prefix entirely. Both count requests.
  { name: "x-ratelimit-remaining", scope: "requests" },
  { name: "ratelimit-remaining", scope: "requests" },
];

/** The limit header paired with a remaining header, by substitution. */
function limitNameFor(remainingName: string): string {
  return remainingName.replace("remaining", "limit");
}

/** The reset header paired with a remaining header, by substitution. */
function resetNameFor(remainingName: string): string {
  return remainingName.replace("remaining", "reset");
}

/**
 * Parse a reset value into epoch milliseconds.
 *
 * Vendors encode this three incompatible ways and none of them say which:
 *
 *   "1789171200000"  OpenRouter — epoch MILLISECONDS (a Sept 2026 date)
 *   "1m26.4s"        Groq — a duration, compound, fractional
 *   "547ms"          Groq — a duration under a second
 *   "60"             several — seconds from now
 *
 * The discriminator is magnitude, not format: a value past the year 2001 in
 * milliseconds cannot be a duration anyone would wait. Returns null rather than
 * guessing when nothing parses, because a wrong reset time tells the operator
 * to come back at the wrong hour.
 */
export function parseResetAt(raw: string | null, now = Date.now()): number | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value === "") return null;

  // Bare digits: epoch ms if implausibly large to be a wait, else seconds.
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    // 10^12 ms ≈ 2001. No vendor asks you to wait thirty years.
    return n > 1e12 ? n : now + n * 1000;
  }

  // Duration forms: 1h2m3.4s, 56m26.88s, 547ms, 3.6s.
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(value);
  if (ms) return now + Number(ms[1]);

  const parts = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/.exec(
    value,
  );
  if (parts && (parts[1] || parts[2] || parts[3])) {
    const hours = Number(parts[1] ?? 0);
    const mins = Number(parts[2] ?? 0);
    const secs = Number(parts[3] ?? 0);
    return now + (hours * 3600 + mins * 60 + secs) * 1000;
  }

  return null;
}

/** Resolve the window for a header that did not name one. */
function windowFor(providerId: string, scope: QuotaScope, stated?: QuotaWindow): QuotaWindow {
  if (stated) return stated;
  return PROVIDER_WINDOWS[providerId]?.[scope] ?? "unknown";
}

/**
 * Every remaining-count this response disclosed.
 *
 * Returns an empty array when the vendor said nothing, which is the common case
 * — Gemini sends no rate-limit headers at all, and several others only meter
 * server-side. An empty array means "did not say", never "nothing left".
 */
export function readQuota(headers: HeaderBag, link: Link, now = Date.now()): QuotaReading[] {
  const readings: QuotaReading[] = [];
  const seen = new Set<string>();

  for (const entry of REMAINING_HEADERS) {
    const raw = headers.get(entry.name);
    if (raw === null || raw.trim() === "") continue;

    const remaining = Number(raw);
    if (!Number.isFinite(remaining)) continue;

    const window = windowFor(link.provider.id, entry.scope, entry.window);
    // A shorter header name must not overwrite the more specific one it is a
    // prefix of: once requests/day is known, a bare requests header is the same
    // counter reported less precisely.
    const key = `${entry.scope}:${window}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const limitRaw = headers.get(limitNameFor(entry.name));
    const limit = limitRaw === null ? null : Number(limitRaw);

    readings.push({
      provider: link.provider.id,
      model: link.model,
      scope: entry.scope,
      window,
      limit: limit !== null && Number.isFinite(limit) ? limit : null,
      remaining,
      resetAt: parseResetAt(headers.get(resetNameFor(entry.name)), now),
      source: entry.name,
      observedAt: now,
    });
  }

  return readings;
}

/**
 * A refusal is the most reliable reading there is.
 *
 * A 429 states the one fact a dashboard most needs and most often has stale:
 * this vendor is spent. It is worth recording even when the response carried no
 * usable headers, because it corrects a local counter that had drifted
 * optimistic — the counter is a model of the vendor, and this is the vendor
 * disagreeing with it.
 */
export function readingFromRefusal(
  link: Link,
  retryAfterSec: number | null,
  scope: QuotaScope = "requests",
  now = Date.now(),
): QuotaReading {
  return {
    provider: link.provider.id,
    model: link.model,
    scope,
    window: windowFor(link.provider.id, scope),
    limit: null,
    remaining: 0,
    resetAt: retryAfterSec === null ? null : now + retryAfterSec * 1000,
    source: "429",
    observedAt: now,
  };
}

/**
 * Turn a remaining-token count into the unit a person thinks in.
 *
 * Nobody has an intuition for a token. "About 40 more answers" is actionable;
 * "7,927 tokens" is a number the reader has to convert before it means
 * anything, and they will convert it wrongly.
 *
 * `tokensPerTurn` is the caller's measured average, because it is a property of
 * their prompts, not of this package. Returns null when the reading cannot
 * support the translation, so the caller shows the raw figure rather than a
 * fabricated one.
 */
export function answersRemaining(reading: QuotaReading, tokensPerTurn: number): number | null {
  if (reading.scope === "requests") return Math.max(0, Math.floor(reading.remaining));
  if (!Number.isFinite(tokensPerTurn) || tokensPerTurn <= 0) return null;
  return Math.max(0, Math.floor(reading.remaining / tokensPerTurn));
}
