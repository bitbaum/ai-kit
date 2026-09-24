/**
 * A background job can never push the day's remaining budget below the floor
 * reserved for people, nor past its own cap; the interactive class is limited
 * only by capacity. Simulated over a whole day of greedy background spending.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BACKGROUND_POLICY, classBudget, estimateTokens } from "@bitbaum/ai-kit";

const policy = { background: BACKGROUND_POLICY };
const CAP = 100_000;

test("a greedy background job stops at its cap and never eats the reader reserve", () => {
  const spent = { interactive: 0, background: 0 };
  let calls = 0;
  for (;;) {
    const d = classBudget({
      dayCapacityTokens: CAP,
      spent,
      cls: "background",
      costTokens: 4_000,
      policy,
    });
    if (!d.allowed) {
      assert.equal(d.reason, "class-cap");
      break;
    }
    spent.background += 4_000;
    calls++;
  }
  assert.ok(spent.background <= 0.25 * CAP, `background spent ${spent.background}`);
  assert.equal(calls, 6);
  // Readers still have three quarters of the day.
  const reader = classBudget({
    dayCapacityTokens: CAP,
    spent,
    cls: "interactive",
    costTokens: 16_000,
    policy,
  });
  assert.equal(reader.allowed, true);
});

test("when readers have used the day, background stops at the floor", () => {
  const spent = { interactive: 45_000, background: 0 };
  const d = classBudget({
    dayCapacityTokens: CAP,
    spent,
    cls: "background",
    costTokens: 8_000,
    policy,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "reserved");
  assert.equal(d.roomTokens, 5_000);
  const small = classBudget({
    dayCapacityTokens: CAP,
    spent,
    cls: "background",
    costTokens: 4_000,
    policy,
  });
  assert.equal(small.allowed, true);
});

test("the interactive class is limited by capacity alone, including into the reserve", () => {
  const spent = { interactive: 90_000, background: 5_000 };
  assert.equal(
    classBudget({ dayCapacityTokens: CAP, spent, cls: "interactive", costTokens: 4_000, policy })
      .allowed,
    true,
  );
  const over = classBudget({
    dayCapacityTokens: CAP,
    spent,
    cls: "interactive",
    costTokens: 6_000,
    policy,
  });
  assert.deepEqual([over.allowed, over.reason], [false, "no-capacity"]);
  assert.equal(
    classBudget({ dayCapacityTokens: 0, spent: {}, cls: "interactive", costTokens: 1, policy })
      .reason,
    "no-capacity",
  );
});

test("token estimate is chars/4, rounded up", () => {
  assert.equal(estimateTokens("abcd", "e"), 2);
  assert.equal(estimateTokens(undefined), 0);
});
