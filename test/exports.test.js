/**
 * Import the package BY NAME, not by relative path into dist/.
 *
 * This is the only test here that can catch a broken `exports` map or a `files`
 * list that forgets to ship dist/: a relative `../dist/index.js` import resolves
 * straight past both, so a package that is impossible to install stays green
 * until someone actually installs it. Node's self-reference resolution (a
 * package may import itself by name when it declares `exports`) is what makes
 * this checkable without publishing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as pkg from 'ai-kit';

test('the package exports its public surface through the exports map', () => {
  const expected = [
    // chain
    'providerModels', 'withEnvPrefix', 'freeChain', 'dayCapacityTokens', 'usableChain', 'chainFrom',
    // limits
    'classifyRateLimit', 'retryAfterSeconds', 'humanizeWait', 'rateLimitMessage',
    // fair-share
    'fairShare', 'utcDayElapsed', 'utcDayKey', 'DAY_SECONDS', 'DEFAULT_BURST',
  ];
  for (const name of expected) {
    assert.ok(name in pkg, `missing export: ${name}`);
  }
});

/**
 * The merge is the feature, so it needs a test.
 *
 * `ai-kit` exists so that adding AI to an app is ONE install rather than four
 * separate decisions — AOZ made one of those decisions (ai-forms), skipped the
 * other two, and was taken down by the one it skipped. If the form-filling
 * re-export silently stops resolving, the package quietly becomes the old
 * ai-ration again under a friendlier name, and nothing else here would notice.
 */
test('form filling is reachable from the root, so one install covers it', async () => {
  const pkg = await import('ai-kit');
  for (const name of ['runFormAssist', 'defineFields', 'mergeValues', 'sanitizeValues']) {
    assert.equal(typeof pkg[name], 'function', `missing re-export: ${name}`);
  }
});

test('the model layer and the form layer coexist without shadowing', async () => {
  const pkg = await import('ai-kit');
  // One from each half. A collision would drop one silently at build time.
  assert.equal(typeof pkg.freeChain, 'function');
  assert.equal(typeof pkg.runFormAssist, 'function');
});

test('./forms resolves through the exports map', async () => {
  const forms = await import('ai-kit/forms');
  assert.equal(typeof forms.runFormAssist, 'function');
});

test('./server resolves, and is what the most-adopted package actually ships', async () => {
  const server = await import('ai-kit/server');
  assert.equal(typeof server.createFormAssistHandler, 'function');
});
