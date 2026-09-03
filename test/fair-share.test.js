/**
 * The policy's goal is NOT maximum throughput — it is "every active user gets a
 * usable amount, every day". The cases below are the ones where those two
 * objectives disagree, which is where a throughput-shaped implementation breaks.
 *
 * Sizes are expressed in units of TURN (a turn's cost) so recalibrating what a
 * turn costs cannot silently move a case into a different branch while its name
 * still claims the old one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { fairShare, utcDayElapsed, utcDayKey, DAY_SECONDS, DEFAULT_BURST } from "@bitbaum/ai-kit";

const TURN = 20_000;
const NOON = 0.5;

const ask = (over) =>
  fairShare({
    dayCapacityTokens: 8 * TURN,
    activeUsers: 2,
    userSpentTokens: 0,
    costTokens: TURN,
    dayElapsed: NOON,
    ...over,
  });

test("a user well inside their paced allowance is admitted", () => {
  const d = ask({});
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "ok");
  assert.equal(d.shareTokens, 4 * TURN);
});

test("no capacity refuses without pretending a wait helps", () => {
  const d = ask({ dayCapacityTokens: 0 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "no-capacity");
  assert.equal(d.retryAfterSeconds, undefined);
});

test("PACED: within the day share but ahead of the clock — a wait genuinely helps", () => {
  // 2 users share 8·TURN → 4·TURN each. At noon the pace has unlocked
  // 0.5 + 0.25 burst = 0.75 of it, i.e. 3·TURN. Having spent 2.5·TURN, a further
  // turn wants 3.5·TURN: past the unlocked allowance, inside the day's share.
  const d = ask({ userSpentTokens: 2.5 * TURN });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "paced");
  assert.equal(typeof d.retryAfterSeconds, "number");
  assert.ok(d.retryAfterSeconds > 0);
});

test("SHARE-SPENT: no retry offered, because no wait can help today", () => {
  // Offering a retry here is the same lie as "try again shortly" on an exhausted
  // daily quota — it invites a request guaranteed to fail until midnight.
  const d = ask({ userSpentTokens: 4 * TURN });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "share-spent");
  assert.equal(d.retryAfterSeconds, undefined);
});

test("THE ONE-TURN FLOOR: a newcomer is never refused their first turn", () => {
  // Pure pacing refuses the opening question of the morning, and to someone
  // trying the product for the first time that is indistinguishable from broken.
  for (const dayElapsed of [0, 0.0001, 0.5, 0.99]) {
    const d = fairShare({
      dayCapacityTokens: 16 * TURN,
      activeUsers: 4,
      userSpentTokens: 0,
      costTokens: TURN,
      dayElapsed,
    });
    assert.equal(d.allowed, true, `newcomer refused at dayElapsed=${dayElapsed}`);
  }
});

test("the floor never hands out more than the share", () => {
  // A turn costing more than a whole share must still be refused, or the floor
  // becomes a hole in the ration rather than a courtesy.
  const d = fairShare({
    dayCapacityTokens: 2 * TURN,
    activeUsers: 4, // share = TURN/2
    userSpentTokens: 0,
    costTokens: TURN, // one turn costs twice the share
    dayElapsed: 0.99,
  });
  assert.equal(d.allowed, false);
  assert.ok(d.allowanceTokens <= d.shareTokens);
});

test("a quiet day is not rationed away — one active user gets the whole pool", () => {
  const d = fairShare({
    dayCapacityTokens: 8 * TURN,
    activeUsers: 1,
    userSpentTokens: 0,
    costTokens: TURN,
    dayElapsed: 0.1,
  });
  assert.equal(d.shareTokens, 8 * TURN, "counting dormant accounts would waste a generous budget");
  assert.equal(d.allowed, true);
});

test("NO CLAWBACK: a newly-arrived second user does not retroactively punish the first", () => {
  // The first user spent 5·TURN while alone and legitimately entitled to it.
  // A second user appearing drops the share to 4·TURN — below what is already
  // spent. The correct outcome is "your allowance stops growing", i.e. a plain
  // refusal, NOT a negative allowance or a crash.
  const d = fairShare({
    dayCapacityTokens: 8 * TURN,
    activeUsers: 2,
    userSpentTokens: 5 * TURN,
    costTokens: TURN,
    dayElapsed: 0.5,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "share-spent");
  assert.ok(d.allowanceTokens >= 0);
});

test("hostile inputs cannot produce a division by zero or a negative allowance", () => {
  for (const activeUsers of [0, -3, NaN]) {
    const d = ask({ activeUsers });
    assert.ok(
      Number.isFinite(d.shareTokens),
      `shareTokens not finite for activeUsers=${activeUsers}`,
    );
    assert.ok(d.shareTokens > 0);
  }
  const skewed = ask({ dayElapsed: -5 });
  assert.ok(skewed.allowanceTokens >= 0, "clock skew must not produce a negative allowance");
  const future = ask({ dayElapsed: 99 });
  assert.ok(
    future.allowanceTokens <= future.shareTokens,
    "a clamped day must not exceed the share",
  );
});

test("the day is measured and bucketed in UTC, where providers meter it", () => {
  assert.equal(utcDayElapsed(new Date("2026-08-15T00:00:00Z")), 0);
  assert.equal(utcDayElapsed(new Date("2026-08-15T12:00:00Z")), 0.5);
  assert.equal(utcDayKey(new Date("2026-08-15T23:59:59Z")), "2026-08-15");
  assert.equal(utcDayKey(new Date("2026-08-16T00:00:01Z")), "2026-08-16");
});

test("the published constants are the ones the policy actually uses", () => {
  assert.equal(DAY_SECONDS, 86_400);
  assert.ok(DEFAULT_BURST > 0 && DEFAULT_BURST < 1);
});
