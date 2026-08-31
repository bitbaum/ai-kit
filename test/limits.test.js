/**
 * The three kinds of 429 need OPPOSITE responses, so a misclassification is not
 * a cosmetic error — it is the difference between recovering and making things
 * worse. These are the real response bodies, not paraphrases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyRateLimit, retryAfterSeconds, humanizeWait, rateLimitMessage } from "ai-kit";

const CAPACITY =
  "Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Used 11800, Requested 400. Please try again in 3.6s.";
const SIZE =
  "Request too large for model `llama-3.1-8b-instant` on tokens per minute (TPM): Limit 6000, Requested 15041, please reduce your message size and try again.";
const DAILY =
  "Rate limit reached for model `llama-3.3-70b-versatile` on tokens per day (TPD): Limit 100000, Used 99331, Requested 4589. Please try again in 56m26.88s.";

test("the three kinds are told apart by BODY, not status", () => {
  assert.equal(classifyRateLimit(CAPACITY), "capacity");
  assert.equal(classifyRateLimit(SIZE), "size");
  assert.equal(classifyRateLimit(DAILY), "daily");
});

test("DAILY wins over CAPACITY — it matches both wordings", () => {
  // The daily body opens with the same "Rate limit reached" phrase as capacity,
  // so a classifier that tests capacity first silently swallows every daily cap
  // and then "helpfully" retries against an empty budget for the rest of the day.
  assert.match(DAILY, /Rate limit reached/);
  assert.equal(classifyRateLimit(DAILY), "daily");
});

test("requests-per-day is treated as daily too", () => {
  assert.equal(
    classifyRateLimit("Rate limit reached on requests per day (RPD): Limit 50"),
    "daily",
  );
});

test("an unrecognisable body degrades to CAPACITY, the safe guess", () => {
  // Guessing "size" would shed context that was never the problem; guessing
  // "daily" would abandon a turn that might well have succeeded.
  assert.equal(classifyRateLimit("some vendor phrasing nobody has seen"), "capacity");
  assert.equal(classifyRateLimit(""), "capacity");
});

test("the wait the provider named is parsed, in both shapes it emits", () => {
  assert.equal(retryAfterSeconds(CAPACITY), 4); // 3.6s → ceil
  assert.equal(retryAfterSeconds(DAILY), 3387); // 56m26.88s
  assert.equal(retryAfterSeconds(SIZE), null, "no stated wait must be null, not zero");
});

test("humanizeWait stays readable across the range", () => {
  assert.equal(humanizeWait(4), "4s");
  assert.equal(humanizeWait(3387), "57 minutes");
  assert.equal(humanizeWait(7200), "about 2 hours");
  assert.equal(humanizeWait(null), null);
  assert.equal(humanizeWait(0), null, "a zero wait is no wait");
  assert.equal(humanizeWait(-5), null);
});

test("the singular hour is REACHABLE — a dead branch is a lie about the output", () => {
  // With the boundary at 90 minutes this was impossible: anything reaching the
  // hours branch divided to >= 1.5, which rounds to 2. So "about 1 hour" could
  // never print, and an hour-long wait was announced as two.
  assert.equal(humanizeWait(3600), "about 1 hour");
  assert.equal(humanizeWait(4800), "about 1 hour");
});

test("the message tells the user whether waiting can possibly help", () => {
  // This is the whole point: "try again shortly" on an exhausted DAY invites
  // exactly the retry that is guaranteed to fail for the next hour.
  assert.match(rateLimitMessage(DAILY), /daily model quota is used up/);
  assert.match(rateLimitMessage(DAILY), /resets in 57 minutes/);

  assert.match(rateLimitMessage(CAPACITY), /rate-limited/);
  assert.match(rateLimitMessage(CAPACITY), /retry in 4s/);

  const size = rateLimitMessage(SIZE);
  assert.match(size, /more context than the model allows/);
  assert.doesNotMatch(size, /try again/i, "retrying is not the fix for an oversized request");
});

test("the message is a CLAUSE the caller can embed", () => {
  for (const body of [CAPACITY, SIZE, DAILY]) {
    const msg = rateLimitMessage(body);
    assert.doesNotMatch(msg, /^[A-Z]/, "a leading capital reads wrong mid-sentence");
    assert.doesNotMatch(msg, /\.$/, "a trailing period double-punctuates the caller");
  }
});
