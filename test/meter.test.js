/**
 * Reading the tank off a response.
 *
 * Every header string below is a real one, captured from a live call on
 * 2026-09-11 — not a paraphrase. The parser exists because vendors disagree
 * about the name, the window and the encoding of the same fact, and each
 * disagreement here cost a measurement to discover.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readQuota, readingFromRefusal, parseResetAt, answersRemaining } from "@bitbaum/ai-kit";

/** Minimal Headers stand-in — case-insensitive, like the real thing. */
function headers(map) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

const link = (id, model = "m") => ({
  provider: { id, baseUrl: "", keyEnv: "K", models: [model], dailyTokens: 0 },
  model,
});

const NOW = Date.UTC(2026, 8, 11, 15, 0, 0);

// ── Groq: two counters, two different windows, one naming convention ────────
test("Groq's remaining-requests is a DAY counter and remaining-tokens is a MINUTE counter", () => {
  // Verified live: the account had 1,000 requests/day and 8,000 tokens/minute.
  // Reading both as per-minute understates the day by three orders of
  // magnitude; reading both as daily hides the limit that actually throttles.
  const readings = readQuota(
    headers({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "999",
      "x-ratelimit-limit-tokens": "8000",
      "x-ratelimit-remaining-tokens": "7927",
      "x-ratelimit-reset-requests": "1m26.4s",
      "x-ratelimit-reset-tokens": "547ms",
    }),
    link("groq"),
    NOW,
  );

  const req = readings.find((r) => r.scope === "requests");
  const tok = readings.find((r) => r.scope === "tokens");

  assert.equal(req.window, "day", "Groq meters requests per DAY");
  assert.equal(req.remaining, 999);
  assert.equal(req.limit, 1000);

  assert.equal(tok.window, "minute", "Groq meters tokens per MINUTE");
  assert.equal(tok.remaining, 7927);

  // Durations, not timestamps — and one of them is sub-second.
  assert.equal(req.resetAt, NOW + 86_400, "1m26.4s");
  assert.equal(tok.resetAt, NOW + 547, "547ms");
});

// ── OpenRouter: the bare header, and an epoch in milliseconds ───────────────
test("OpenRouter's bare remaining header is a daily REQUEST count", () => {
  const [reading] = readQuota(
    headers({
      "x-ratelimit-limit": "50",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1789171200000",
    }),
    link("openrouter"),
    NOW,
  );

  assert.equal(reading.scope, "requests");
  assert.equal(reading.window, "day", "the unpaid tier is 50 requests per day");
  assert.equal(reading.remaining, 0);
  assert.equal(reading.limit, 50);
  // Epoch milliseconds, not a duration — midnight UTC, the daily reset.
  assert.equal(new Date(reading.resetAt).toISOString(), "2026-09-12T00:00:00.000Z");
});

// ── The silent majority ─────────────────────────────────────────────────────
test("a vendor that says nothing yields NO readings, never a zero", () => {
  // Gemini sends no rate-limit headers at all. Inventing a reading here is the
  // bug that makes a dashboard lie: absent is a third state, and the caller
  // must render it as unknown.
  const readings = readQuota(headers({ "content-type": "application/json" }), link("google"), NOW);
  assert.deepEqual(readings, [], "no header means no claim");
});

test("an unlisted vendor reports its window as unknown rather than guessing", () => {
  const [reading] = readQuota(
    headers({ "x-ratelimit-remaining-requests": "17" }),
    link("some-new-vendor"),
    NOW,
  );
  assert.equal(reading.remaining, 17);
  assert.equal(reading.window, "unknown", "a guessed window is a wrong number with confidence");
});

// ── Name collisions ─────────────────────────────────────────────────────────
test("a -day header is not overwritten by the shorter name it contains", () => {
  // SambaNova sends both. Read in the wrong order, the day counter (20) is
  // replaced by the minute counter (19) under the same key, and the dashboard
  // reports a daily allowance that refills every minute.
  const readings = readQuota(
    headers({
      "x-ratelimit-remaining-requests": "19",
      "x-ratelimit-limit-requests-day": "20",
      "x-ratelimit-remaining-requests-day": "14",
    }),
    link("sambanova"),
    NOW,
  );

  const day = readings.find((r) => r.window === "day");
  const minute = readings.find((r) => r.window === "minute");
  assert.equal(day.remaining, 14, "the day counter survives");
  assert.equal(day.limit, 20);
  assert.equal(minute.remaining, 19, "and the minute counter is kept separately");
});

test("OVHcloud's prefix-less header is still read", () => {
  const [reading] = readQuota(headers({ "ratelimit-remaining": "1" }), link("ovh"), NOW);
  assert.equal(reading.remaining, 1);
  assert.equal(reading.scope, "requests");
});

// ── Reset encodings ─────────────────────────────────────────────────────────
test("the three reset encodings are told apart by magnitude, not format", () => {
  assert.equal(parseResetAt("1789171200000", NOW), 1789171200000, "epoch ms passes through");
  assert.equal(parseResetAt("60", NOW), NOW + 60_000, "bare small integer is seconds");
  assert.equal(parseResetAt("3.6s", NOW), NOW + 3600);
  assert.equal(parseResetAt("56m26.88s", NOW), NOW + 3_386_880);
  assert.equal(parseResetAt("1h2m3s", NOW), NOW + 3_723_000);
  assert.equal(parseResetAt("547ms", NOW), NOW + 547);
});

test("an unparseable reset is null, never a guess", () => {
  // A wrong reset time tells the operator to come back at the wrong hour, which
  // is worse than telling them nothing.
  assert.equal(parseResetAt("soon", NOW), null);
  assert.equal(parseResetAt("", NOW), null);
  assert.equal(parseResetAt(null, NOW), null);
});

// ── The refusal reading ─────────────────────────────────────────────────────
test("a refusal records an empty tank and when it refills", () => {
  const reading = readingFromRefusal(link("groq"), 3386, "tokens", NOW);
  assert.equal(reading.remaining, 0);
  assert.equal(reading.source, "429");
  assert.equal(reading.resetAt, NOW + 3_386_000);
});

test("a refusal with no stated wait still records the emptiness", () => {
  // The vendor disagreeing with a local counter is the point; not knowing when
  // it refills does not make that disagreement less true.
  const reading = readingFromRefusal(link("openrouter"), null, "requests", NOW);
  assert.equal(reading.remaining, 0);
  assert.equal(reading.resetAt, null);
});

// ── Translation into the unit a person thinks in ────────────────────────────
test("tokens become answers, because nobody has an intuition for a token", () => {
  const tokens = {
    provider: "groq",
    model: "m",
    scope: "tokens",
    window: "minute",
    limit: 8000,
    remaining: 7927,
    resetAt: null,
    source: "x-ratelimit-remaining-tokens",
    observedAt: NOW,
  };
  assert.equal(answersRemaining(tokens, 2000), 3, "7927 tokens at ~2k a turn is 3 answers");
});

test("a request counter is already in answers", () => {
  const requests = {
    provider: "openrouter",
    model: "m",
    scope: "requests",
    window: "day",
    limit: 50,
    remaining: 12,
    resetAt: null,
    source: "x-ratelimit-remaining",
    observedAt: NOW,
  };
  assert.equal(answersRemaining(requests, 2000), 12);
});

test("an impossible translation returns null rather than a fabricated count", () => {
  const tokens = {
    provider: "groq",
    model: "m",
    scope: "tokens",
    window: "minute",
    limit: null,
    remaining: 500,
    resetAt: null,
    source: "x",
    observedAt: NOW,
  };
  assert.equal(answersRemaining(tokens, 0), null);
  assert.equal(answersRemaining(tokens, Number.NaN), null);
});
