/**
 * The registry's two jobs, each pinned to the incident that created it:
 *
 *  ENUMERATION — "a model id is callable only if it appears here." An id that
 *  no probe enumerates is an id whose death nobody reports (eight days of
 *  `model_not_found`, 2026-08-18).
 *
 *  THE BILLING BOUNDARY — paid/free is a FIELD the validator defends, never a
 *  `:free` suffix convention (three apps silently billed on fallback because
 *  the suffix was the whole difference).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defineRegistry, freeOnly, toolCapable } from 'ai-kit/registry';

const ENTRIES = [
  { id: 'openai/gpt-oss-20b', vendor: 'groq', paid: false, toolProtocol: 'native', usedFor: 'default chat' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', vendor: 'openrouter', paid: false, toolProtocol: 'text' },
  { id: 'moonshotai/kimi-k2', vendor: 'openrouter', author: 'Moonshot', paid: true, inputCostPer1M: 0.6, outputCostPer1M: 2.5 },
  { id: 'anthropic/claude-fable-5', vendor: 'openrouter', author: 'Anthropic', paid: true, inputCostPer1M: 15, outputCostPer1M: 75, supportsTemperature: false },
  { id: 'whisper-large-v3', vendor: 'groq', paid: false, kind: 'transcribe' },
];

test('require() throws loudly for an unregistered id — the enumeration rule', () => {
  const reg = defineRegistry(ENTRIES);
  assert.equal(reg.require('openai/gpt-oss-20b').vendor, 'groq');
  assert.throws(() => reg.require('llama-3.3-70b-versatile'), /not registered/);
});

test('a free entry carrying a cost refuses to load — the flag or the price is lying', () => {
  assert.throws(
    () => defineRegistry([{ id: 'x', vendor: 'v', paid: false, inputCostPer1M: 3 }]),
    /declared free but carries a cost/,
  );
});

test('a paid entry with a :free id refuses to load — the flag or the id is lying', () => {
  assert.throws(
    () => defineRegistry([{ id: 'model:free', vendor: 'v', paid: true }]),
    /declared paid but the id says :free/,
  );
});

test('duplicate (vendor, id) refuses to load — one callable id, one row', () => {
  assert.throws(
    () => defineRegistry([
      { id: 'a', vendor: 'v', paid: false },
      { id: 'a', vendor: 'v', paid: false },
    ]),
    /duplicate entry/,
  );
});

test('freeOnly drops paid AND unregistered ids, and says which and why', () => {
  const reg = defineRegistry(ENTRIES);
  const { allowed, dropped } = freeOnly(reg, [
    'openai/gpt-oss-20b',
    'anthropic/claude-fable-5',
    'model-nobody-registered',
  ]);
  assert.deepEqual(allowed, ['openai/gpt-oss-20b']);
  assert.deepEqual(dropped, [
    { id: 'anthropic/claude-fable-5', why: 'paid' },
    { id: 'model-nobody-registered', why: 'unregistered' },
  ]);
});

test('toolCapable accepts native AND text protocols, refuses none/unprobed', () => {
  const reg = defineRegistry([
    ...ENTRIES,
    { id: 'probed-toolless', vendor: 'v', paid: false, toolProtocol: 'none' },
  ]);
  const { usable, refused } = toolCapable(reg, [
    'openai/gpt-oss-20b',                       // native
    'nvidia/nemotron-3-super-120b-a12b:free',   // text — 5 of 9 probed free models only speak this
    'probed-toolless',                          // probed, cannot
    'moonshotai/kimi-k2',                       // never probed
  ]);
  assert.deepEqual(usable, ['openai/gpt-oss-20b', 'nvidia/nemotron-3-super-120b-a12b:free']);
  assert.deepEqual(refused, [
    { id: 'probed-toolless', protocol: 'none' },
    { id: 'moonshotai/kimi-k2', protocol: 'unprobed' },
  ]);
});

test('idsForVendor is the enumeration a catalog check walks', () => {
  const reg = defineRegistry(ENTRIES);
  assert.deepEqual(reg.idsForVendor('groq'), ['openai/gpt-oss-20b', 'whisper-large-v3']);
  assert.deepEqual(reg.vendors().sort(), ['groq', 'openrouter']);
});
