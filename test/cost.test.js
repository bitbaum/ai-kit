/**
 * `modelCost` exists because one mistake appeared in THREE apps on one day:
 * a fallback that silently began spending the moment the free tier ran dry.
 * These cases are the real ids that were found in production config.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { modelCost, paidModelsIn, freeChain } from 'ai-ration';

test('the three ids that were actually billing are all caught', () => {
  assert.equal(modelCost('anthropic/claude-sonnet-5'), 'paid');
  assert.equal(modelCost('google/gemini-2.0-flash-001'), 'paid');
  // Reads free, bills at 1e-7/token, and its `:free` sibling has been retired.
  assert.equal(modelCost('meta-llama/llama-3.3-70b-instruct'), 'paid');
});

test('the `:free` suffix is the whole difference', () => {
  assert.equal(modelCost('openai/gpt-oss-20b:free'), 'free');
  assert.equal(modelCost('openai/gpt-oss-20b'), 'paid');
  assert.equal(modelCost('openrouter/free'), 'free', 'the free auto-router');
});

test('a bare vendor id is UNKNOWN, never assumed free', () => {
  // Whether `llama-3.1-8b-instant` costs depends on the account tier at Groq —
  // no string can answer that. Guessing "free" is the direction that let three
  // of these through review, so it must not be the default.
  assert.equal(modelCost('llama-3.1-8b-instant'), 'unknown');
  assert.equal(modelCost('llama-3.3-70b-versatile'), 'unknown');
  assert.equal(modelCost(''), 'unknown');
  assert.equal(modelCost('   '), 'unknown');
});

test('the shipped free chain contains no paid model', () => {
  // The package would have no standing to flag anyone else's chain otherwise.
  assert.deepEqual(paidModelsIn(freeChain('TEST')), []);
});
