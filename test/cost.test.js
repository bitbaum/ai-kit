/**
 * `modelCost` exists because one mistake appeared in THREE apps on one day:
 * a fallback that silently began spending the moment the free tier ran dry.
 * These cases are the real ids that were found in production config.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { modelCost, modelCostAt, paidModelsIn, freeChain } from "ai-kit";

test("the three ids that were actually billing are all caught", () => {
  assert.equal(modelCost("anthropic/claude-sonnet-5"), "paid");
  assert.equal(modelCost("google/gemini-2.0-flash-001"), "paid");
  // Reads free, bills at 1e-7/token, and its `:free` sibling has been retired.
  assert.equal(modelCost("meta-llama/llama-3.3-70b-instruct"), "paid");
});

test("the `:free` suffix is the whole difference", () => {
  assert.equal(modelCost("openai/gpt-oss-20b:free"), "free");
  assert.equal(modelCost("openai/gpt-oss-20b"), "paid");
  assert.equal(modelCost("openrouter/free"), "free", "the free auto-router");
});

test("a bare vendor id is UNKNOWN, never assumed free", () => {
  // Whether `llama-3.1-8b-instant` costs depends on the account tier at Groq —
  // no string can answer that. Guessing "free" is the direction that let three
  // of these through review, so it must not be the default.
  assert.equal(modelCost("llama-3.1-8b-instant"), "unknown");
  assert.equal(modelCost("llama-3.3-70b-versatile"), "unknown");
  assert.equal(modelCost(""), "unknown");
  assert.equal(modelCost("   "), "unknown");
});

test("the shipped free chain contains no paid model", () => {
  // The package would have no standing to flag anyone else's chain otherwise.
  assert.deepEqual(paidModelsIn(freeChain("TEST")), []);
});

const routed = {
  id: "openrouter",
  baseUrl: "x",
  keyEnv: "K",
  models: [],
  dailyTokens: 1,
  routed: true,
};
const direct = { id: "groq", baseUrl: "x", keyEnv: "K", models: [], dailyTokens: 1 };

test("the same id is PAID at a routed vendor and UNKNOWN at a direct one", () => {
  // Cost is not a property of the string. `openai/gpt-oss-20b` bills at
  // OpenRouter (routed, no `:free`); at Groq it is that vendor's own name for a
  // model whose cost is the account's tier. Judging by shape alone was safe
  // only while direct vendors used bare ids like `llama-3.1-8b-instant` — Groq
  // now ships vendor-prefixed ids, which is what broke this.
  assert.equal(modelCostAt(routed, "openai/gpt-oss-20b"), "paid");
  assert.equal(modelCostAt(direct, "openai/gpt-oss-20b"), "unknown");
  assert.equal(modelCostAt(routed, "openai/gpt-oss-20b:free"), "free");
});

test('a direct vendor never yields "free" from the id alone', () => {
  // "unknown" is the honest answer AND the safe direction. Returning "free"
  // here would reopen the exact hole modelCost was written to close.
  for (const id of ["openai/gpt-oss-120b", "llama-3.1-8b-instant", "anything/at-all:free"]) {
    assert.notEqual(modelCostAt(direct, id), "free", `${id} was assumed free at a direct vendor`);
  }
});

test("provider-awareness does NOT weaken the guard where the real incidents were", () => {
  // All three production incidents were routed ids missing `:free`. Those must
  // still be caught, or this change traded a false alarm for a real miss.
  const chain = [
    { ...direct, models: ["openai/gpt-oss-120b"] },
    { ...routed, models: ["anthropic/claude-sonnet-5", "google/gemini-2.0-flash-001"] },
  ];
  assert.deepEqual(paidModelsIn(chain), [
    "anthropic/claude-sonnet-5",
    "google/gemini-2.0-flash-001",
  ]);
});
