/**
 * The grounding and registry subpaths must load under BOTH loaders.
 *
 * Why a require condition exists at all: OrangeCat's jest runs ts-jest in CJS
 * mode, and its config documents the trap in its own words — the transform
 * compiles only .ts/.tsx, so "an ESM-only .js dependency cannot be whitelisted
 * into working via transformIgnorePatterns alone". That is the failure class
 * that broke AOZ's Jest inside ai-forms in v0.3, and the v0.4 lesson applies
 * unchanged: fix it in the package, not with per-adopter workarounds. A CJS
 * consumer resolves `require` and gets dist-cjs; everything else resolves
 * `default` and gets ESM dist, exactly as before.
 *
 * This test is the mutation-proof: delete the dist-cjs build or the marker
 * package.json and the createRequire half fails; break the ESM build and the
 * import half fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as esmGrounding from 'ai-kit/grounding';
import * as esmRegistry from 'ai-kit/registry';

const require = createRequire(import.meta.url);

test('ESM import serves the grounding surface', () => {
  assert.equal(typeof esmGrounding.verifyAnswer, 'function');
  assert.equal(esmGrounding.NOT_RECORDED, '<not recorded>');
  assert.equal(typeof esmRegistry.defineRegistry, 'function');
});

test('CJS require serves the SAME surface through the require condition', () => {
  const g = require('ai-kit/grounding');
  const r = require('ai-kit/registry');
  assert.equal(typeof g.verifyAnswer, 'function');
  assert.equal(g.NOT_RECORDED, '<not recorded>');
  assert.equal(typeof r.defineRegistry, 'function');

  // Same behavior, not merely same names: both loaders must agree on a verdict.
  const answer = 'Your contact is Ilya Druzhnikov (UZH).';
  const viaEsm = esmGrounding.verifyAnswer({ answer, facts: [], userMessage: 'who?' });
  const viaCjs = g.verifyAnswer({ answer, facts: [], userMessage: 'who?' });
  assert.equal(viaEsm.ok, viaCjs.ok);
  assert.equal(viaEsm.ok, false);
});
