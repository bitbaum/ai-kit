/**
 * The policy is the thing the gate and the settings page have to AGREE about.
 *
 * Across this fleet the same feature was built twice, half each: one app
 * enforces a daily budget with no interface, another draws a quota meter the
 * enforcement path never reads. These tests pin the properties that make one
 * object serve both — and the ones that keep a refusal from being a dead end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, shouldSurface, nextUtcReset, DEFAULT_LADDER } from "@bitbaum/ai-kit";

const POLICY = {
  tiers: {
    anonymous: { turnsPerDay: 3, pool: "platform" },
    free: { turnsPerDay: 20, pool: "platform" },
    byok: { turnsPerDay: null, pool: "user" },
    local: { turnsPerDay: null, pool: "local" },
    paid: { turnsPerDay: null, pool: "platform", meter: "credits" },
  },
};

const NOW = Date.UTC(2026, 8, 11, 15, 0, 0);

// ── Counting ────────────────────────────────────────────────────────────────
test("a capped tier reports what is left, and the gate and the meter read the same number", () => {
  const d = decide(POLICY, { tier: "free", spentToday: 8 }, NOW);
  assert.equal(d.allowed, true);
  assert.equal(d.remaining, 12);
  assert.equal(d.pool, "platform");
});

test("spending the day closes the gate and produces a wall, not a bare refusal", () => {
  const d = decide(POLICY, { tier: "free", spentToday: 20 }, NOW);
  assert.equal(d.allowed, false);
  assert.equal(d.remaining, 0);
  assert.equal(d.wall.reason, "day-spent");
  assert.ok(d.wall.options.length > 1, "a refusal carries ways out");
});

test("an uncapped tier has NO number — null is not zero", () => {
  // Rendering null as a gauge at zero would tell a user on their own key that
  // they are out, which is the opposite of true.
  const d = decide(POLICY, { tier: "byok", spentToday: 900 }, NOW);
  assert.equal(d.allowed, true);
  assert.equal(d.remaining, null, "there is nothing to draw a level against");
  assert.equal(d.pool, "user");
});

// ── Failing closed ──────────────────────────────────────────────────────────
test("an unknown tier is refused, not waved through", () => {
  // A typo in a config must cost nothing, not hand out the shared pool.
  const d = decide(POLICY, { tier: "premiun", spentToday: 0 }, NOW);
  assert.equal(d.allowed, false);
  assert.equal(d.wall.reason, "unknown-tier");
  assert.equal(d.policy, null);
});

// ── Credits ─────────────────────────────────────────────────────────────────
test("a credit tier spends a balance, not a daily count", () => {
  assert.equal(decide(POLICY, { tier: "paid", spentToday: 500, credits: 10 }, NOW).allowed, true);
  const broke = decide(POLICY, { tier: "paid", spentToday: 0, credits: 0 }, NOW);
  assert.equal(broke.allowed, false);
  assert.equal(broke.wall.reason, "no-credits");
});

// ── The ladder ──────────────────────────────────────────────────────────────
test("free exits are offered before the one that costs money", () => {
  const { options } = decide(POLICY, { tier: "free", spentToday: 20 }, NOW).wall;
  const order = options.map((o) => o.rung);
  assert.ok(
    order.indexOf("byok") < order.indexOf("paid"),
    `asking for money before asking for a free account converts worse: ${order.join(" → ")}`,
  );
  assert.equal(DEFAULT_LADDER[0], "byok");
});

test("wait is ALWAYS the floor, even if a config tries to remove it", () => {
  // A refusal with no way forward reads as broken. The honest floor is "this
  // refills, and here is when".
  const noWait = { ...POLICY, ladder: ["paid"] };
  const { options, resetAt } = decide(noWait, { tier: "free", spentToday: 20 }, NOW).wall;
  const last = options[options.length - 1];
  assert.equal(last.rung, "wait");
  assert.equal(last.available, true);
  assert.equal(new Date(resetAt).toISOString(), "2026-09-12T00:00:00.000Z");
});

test("a rung the user cannot take is offered as unavailable, not silently dropped", () => {
  // Dropping it makes the list differ per user for reasons nobody can see;
  // marking it lets the interface explain why.
  const { options } = decide(
    POLICY,
    { tier: "free", spentToday: 20, available: { local: false } },
    NOW,
  ).wall;
  const local = options.find((o) => o.rung === "local");
  assert.equal(local.available, false);
});

// ── When to speak ───────────────────────────────────────────────────────────
test("the indicator stays quiet early and speaks near the edge", () => {
  // A permanent gauge at 96% trains people to ignore the one at 4%.
  const fresh = decide(POLICY, { tier: "free", spentToday: 1 }, NOW);
  const nearly = decide(POLICY, { tier: "free", spentToday: 15 }, NOW);
  const spent = decide(POLICY, { tier: "free", spentToday: 20 }, NOW);

  assert.equal(shouldSurface(fresh), false, "19 of 20 left is not news");
  assert.equal(shouldSurface(nearly), true, "5 of 20 left is");
  assert.equal(shouldSurface(spent), true, "a wall always surfaces");
});

test("an uncapped tier never surfaces a count it does not have", () => {
  assert.equal(shouldSurface(decide(POLICY, { tier: "byok", spentToday: 0 }, NOW)), false);
});

// ── The reset boundary ──────────────────────────────────────────────────────
test("the reset is the next UTC midnight, matching how vendors meter days", () => {
  assert.equal(
    new Date(nextUtcReset(Date.UTC(2026, 8, 11, 23, 59, 59))).toISOString(),
    "2026-09-12T00:00:00.000Z",
  );
  assert.equal(
    new Date(nextUtcReset(Date.UTC(2026, 11, 31, 12, 0, 0))).toISOString(),
    "2027-01-01T00:00:00.000Z",
    "and it rolls the year",
  );
});
