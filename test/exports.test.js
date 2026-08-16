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

import * as pkg from 'ai-ration';

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
