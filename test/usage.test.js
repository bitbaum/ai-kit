/**
 * What the budget numbers mean (src/usage.ts).
 *
 * The property under test is that every app phrases a budget the same honest
 * way: no forecast from one sample, an empty week is absent rather than zero,
 * a remainder is counted the way a gate admits it, and a refill time is never
 * guessed. Numbers are checkable by hand: a 10-unit day observed at 06:00 UTC
 * (a quarter of the day gone).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  admissionsLeft,
  clockAt,
  countOf,
  historyWindowLine,
  nextUtcMidnight,
  paceForecast,
  paceLine,
  refillsIn,
  weekSummary,
  utcResetExplanation,
} from "@bitbaum/ai-kit";

const SIX_AM = new Date("2026-10-12T06:00:00Z");

test("paceForecast says nothing before there is a rate to project", () => {
  assert.equal(paceForecast({ used: 1, limit: 10, now: SIX_AM }), null);
  assert.equal(paceForecast({ used: 3, limit: 10, now: new Date("2026-10-12T00:30:00Z") }), null);
  assert.equal(paceForecast({ used: 10, limit: 10, now: SIX_AM }), null, "already at the limit");
  assert.equal(paceForecast({ used: 4, limit: 0, now: SIX_AM }), null, "no limit to reach");
});

test("paceForecast says the day lasts, or when the limit is reached", () => {
  // 2 by 06:00 → 8 for the day, under 10.
  assert.deepEqual(paceForecast({ used: 2, limit: 10, now: SIX_AM }), { lastsTheDay: true });
  // 5 by 06:00 → 10 reached at 12:00.
  const f = paceForecast({ used: 5, limit: 10, now: SIX_AM });
  assert.equal(f.lastsTheDay, false);
  assert.equal(f.clock, "12:00 UTC");
  assert.equal(f.reachesAt, 0.5);
});

test("paceForecast honours a caller's own minimum sample", () => {
  // In tokens, two units is nothing; a caller says what a sample is.
  assert.equal(paceForecast({ used: 30, limit: 100_000, now: SIX_AM, minUsed: 40_000 }), null);
});

test("paceLine phrases both outcomes with the product's subject and verb agreement", () => {
  const lasts = paceForecast({ used: 2, limit: 10, now: SIX_AM });
  assert.equal(
    paceLine(lasts, { subject: "your 10 messages", plural: true }),
    "At today's pace your 10 messages last the whole day.",
  );
  assert.equal(
    paceLine(lasts, { subject: "your share" }),
    "At today's pace your share lasts the whole day.",
  );
  const runs = paceForecast({ used: 5, limit: 10, now: SIX_AM });
  assert.equal(
    paceLine(runs, { subject: "your share", then: " — pacing slows you before that" }),
    "At today's pace your share runs out around 12:00 UTC — pacing slows you before that.",
  );
  assert.equal(paceLine(null, { subject: "x" }), null);
});

test("weekSummary counts use, active days and capped days — and an empty week is absent", () => {
  const days = [10, 0, 4, 10, 2, 0, 3].map((used) => ({ used }));
  assert.deepEqual(weekSummary(days, 10), { total: 29, activeDays: 5, cappedDays: 2 });
  assert.deepEqual(weekSummary(days), { total: 29, activeDays: 5, cappedDays: 0 });
  assert.equal(weekSummary([{ used: 0 }, { used: 0 }], 10), null);
  assert.equal(weekSummary(null, 10), null);
});

test("admissionsLeft counts the way a gate admits, not by bare division", () => {
  // 40k left, gate estimates 20k, real answers cost 2k: 1 + 10, not 20.
  assert.equal(admissionsLeft(40_000, 20_000, 2_000), 11);
  // Below the estimate the gate refuses, however cheap the turns.
  assert.equal(admissionsLeft(15_000, 20_000, 2_000), 0);
  assert.equal(admissionsLeft(20_000, 20_000, 2_000), 1);
  assert.equal(admissionsLeft(75_000, 20_000, 6_000), 10);
});

test("refillsIn never guesses, and says the sub-minute case honestly", () => {
  const now = Date.parse("2026-10-12T06:00:00Z");
  assert.equal(refillsIn(null, now), null);
  assert.equal(refillsIn("not a date", now), null);
  assert.equal(refillsIn(now - 1, now), "now");
  assert.equal(refillsIn(now + 40_000, now), "in under a minute");
  assert.equal(refillsIn(now + 12 * 60_000, now), "in 12 minutes");
  assert.equal(refillsIn(new Date(now + 18 * 3_600_000), now), "in 18 hours");
  assert.equal(refillsIn(now + 3 * 86_400_000, now), "in 3 days");
});

test("nextUtcMidnight and clockAt follow the UTC day", () => {
  assert.equal(
    nextUtcMidnight(new Date("2026-10-12T23:59:59Z")).toISOString(),
    "2026-10-13T00:00:00.000Z",
  );
  assert.equal(
    nextUtcMidnight(new Date("2026-10-12T00:00:00Z")).toISOString(),
    "2026-10-13T00:00:00.000Z",
  );
  assert.equal(clockAt(0.7), "16:48 UTC");
  assert.equal(clockAt(2), "00:00 UTC", "clamped: the end of the day reads as midnight");
});

test("historyWindowLine states the window in the product's words", () => {
  assert.equal(
    historyWindowLine({ assistant: "Cat", items: 20, unit: "message", memory: "Memory" }),
    "In a conversation Cat reads your last 20 messages; anything older it no longer sees. " +
      "What should outlast that belongs in Memory, which Cat recalls in every chat.",
  );
  assert.equal(
    historyWindowLine({ assistant: "Loki", items: 8, unit: "turn", trimmedChars: 600 }),
    "In a conversation Loki reads your last 8 turns, each trimmed to about 600 characters; " +
      "anything older it no longer sees.",
  );
});

test("countOf uses the app's formatter and plural", () => {
  // A formatter with no locale data behind it: ICU differs between Node
  // releases (de-CH groups with ' on one and ’ on another), and what is under
  // test is that countOf USES the formatter it is given, not ICU.
  const underscores = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  assert.equal(countOf(12_000, "token", { format: underscores }), "12_000 tokens");
  assert.equal(countOf(1, "day"), "1 day");
  assert.equal(countOf(2, "body", { plural: "bodies" }), "2 bodies");
});

test("the reset explanation claims only what the counter does, in the product's unit", () => {
  const generic = utcResetExplanation();
  assert.match(generic.body, /per UTC day/);
  assert.match(generic.body, /Unused allowance doesn't roll over\.$/);
  assert.match(utcResetExplanation("messages").body, /Unused messages don't roll over\.$/);
  // Groq refills on its own rolling clock, so "the providers refill at
  // midnight" would be false in every app that shows this sentence.
  assert.doesNotMatch(generic.body, /refill/i);
});
