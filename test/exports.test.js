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
    // attempt
    'tryChain', 'ChainExhaustedError',
    // health
    'createHealthTracker',
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
 * The merge is the feature, so it needs a test — but the feature is ONE INSTALL,
 * not one import.
 *
 * `ai-kit` exists so that adding AI to an app is a single decision rather than
 * four: AOZ made one of those decisions (ai-forms), skipped the other two, and
 * was taken down by one it skipped. Everything below still ships from this one
 * package at one version. What changed is WHERE from.
 */
test('form filling is reachable from the package, so one install covers it', async () => {
  const forms = await import('ai-kit/forms');
  for (const name of ['runFormAssist', 'defineFields', 'mergeValues', 'sanitizeValues']) {
    assert.equal(typeof forms[name], 'function', `missing export: ${name}`);
  }
});

/**
 * ...and it must NOT be reachable from the root. This is a regression test with
 * a scar behind it.
 *
 * For one release the root re-exported forms, so `import { freeChain } from
 * 'ai-kit'` dragged `ai-forms` in behind it. That package is ESM-only, so the
 * first adopting app's Jest run — which executes CJS — died on `Unexpected token
 * 'export'` inside a module it had never asked for. The remedy would have been a
 * `transformIgnorePatterns` entry in that app, then the next, then every app
 * after: one class of breakage, paid per repo, forever.
 *
 * So the absence is the contract. A convenience re-export added back at the root
 * would look harmless in review and break the next consumer the same way.
 */
test('the root does NOT drag the form layer in behind the chain', async () => {
  const pkg = await import('ai-kit');
  assert.equal(typeof pkg.freeChain, 'function', 'the chain belongs at the root');
  for (const name of ['runFormAssist', 'defineFields']) {
    assert.equal(
      name in pkg,
      false,
      `${name} is re-exported from the root again — a chain-only consumer now loads ai-forms`,
    );
  }
});

test('./forms resolves through the exports map', async () => {
  const forms = await import('ai-kit/forms');
  assert.equal(typeof forms.runFormAssist, 'function');
});

test('./server resolves, and is what the most-adopted package actually ships', async () => {
  const server = await import('ai-kit/server');
  assert.equal(typeof server.createFormAssistHandler, 'function');
});
