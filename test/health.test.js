/**
 * The tracker's whole job is turning a run of successes/failures into a
 * status a health route can trust — pinned here, transition by transition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHealthTracker } from 'ai-kit';

test('starts unknown — no evidence either way yet', () => {
  const tracker = createHealthTracker();
  assert.equal(tracker.getHealth().status, 'unknown');
});

test('one success is ok, not merely "not down"', () => {
  const tracker = createHealthTracker();
  tracker.recordSuccess();
  const health = tracker.getHealth();
  assert.equal(health.status, 'ok');
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.lastError, null);
});

test('failures short of the threshold are degraded, not down', () => {
  const tracker = createHealthTracker({ downAfter: 3 });
  tracker.recordFailure(new Error('401'));
  assert.equal(tracker.getHealth().status, 'degraded');
  tracker.recordFailure(new Error('401'));
  assert.equal(tracker.getHealth().status, 'degraded');
});

test('the Nth consecutive failure flips it down, exactly at the threshold', () => {
  const tracker = createHealthTracker({ downAfter: 3 });
  tracker.recordFailure(new Error('a'));
  tracker.recordFailure(new Error('b'));
  tracker.recordFailure(new Error('c'));
  const health = tracker.getHealth();
  assert.equal(health.status, 'down');
  assert.equal(health.consecutiveFailures, 3);
  assert.equal(health.lastError, 'c');
});

test('a single success recovers a down tracker to ok, not degraded', () => {
  const tracker = createHealthTracker({ downAfter: 2 });
  tracker.recordFailure(new Error('x'));
  tracker.recordFailure(new Error('y'));
  assert.equal(tracker.getHealth().status, 'down');

  tracker.recordSuccess();
  const health = tracker.getHealth();
  assert.equal(health.status, 'ok');
  assert.equal(health.consecutiveFailures, 0, 'the streak must reset, not merely drop below threshold');
});

test('a non-Error failure still records a readable message', () => {
  const tracker = createHealthTracker();
  tracker.recordFailure('plain string failure');
  assert.equal(tracker.getHealth().lastError, 'plain string failure');
});

test('reset returns to unknown, clearing every field', () => {
  const tracker = createHealthTracker();
  tracker.recordFailure(new Error('boom'));
  tracker.reset();
  assert.deepEqual(tracker.getHealth(), {
    status: 'unknown',
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  });
});

test('the clock is injectable, not read from a global', () => {
  let now = 1000;
  const tracker = createHealthTracker({ now: () => now });
  tracker.recordSuccess();
  assert.equal(tracker.getHealth().lastSuccessAt, 1000);
  now = 2000;
  tracker.recordFailure(new Error('later'));
  assert.equal(tracker.getHealth().lastFailureAt, 2000);
});

test('two independent trackers never share state — no hidden singleton', () => {
  const a = createHealthTracker();
  const b = createHealthTracker();
  a.recordFailure(new Error('only a'));
  assert.equal(a.getHealth().status, 'degraded');
  assert.equal(b.getHealth().status, 'unknown');
});
