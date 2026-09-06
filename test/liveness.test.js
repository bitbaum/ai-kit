/**
 * The probe exists because a health tracker that has recorded nothing looks
 * identical whether the chain is perfect or every key is missing. These tests
 * hold it to the two properties that make it safe to expose: it tells the truth
 * about NOW, and it cannot be used to drain the daily budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createLivenessProbe, createAiHealthHandler, createHealthTracker } from "@bitbaum/ai-kit";

const ENV = { GROQ_API_KEY: "g" };

function chain(models = ["big"]) {
  const provider = {
    id: "groq",
    baseUrl: "https://groq.invalid/v1",
    keyEnv: "GROQ_API_KEY",
    models,
    dailyTokens: 1000,
  };
  return models.map((model) => ({ provider, model }));
}

function ok(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
  });
}

function counting(reply) {
  const calls = { n: 0 };
  return [
    async () => {
      calls.n += 1;
      return typeof reply === "function" ? reply() : reply;
    },
    calls,
  ];
}

test("a successful probe reports the answer and which link served it", async () => {
  const [fetchImpl] = counting(() => ok("blue"));
  const probe = createLivenessProbe({ chain: chain(), env: ENV, fetchImpl });

  const r = await probe.run();
  assert.equal(r.ok, true);
  assert.equal(r.answer, "blue");
  assert.equal(r.servedBy, "groq/big");
  assert.equal(r.cached, false);
});

test("a second probe inside the window is CACHED — it must not spend tokens twice", async () => {
  const [fetchImpl, calls] = counting(() => ok("blue"));
  let clock = 1000;
  const probe = createLivenessProbe({
    chain: chain(),
    env: ENV,
    fetchImpl,
    minIntervalMs: 60_000,
    now: () => clock,
  });

  await probe.run();
  clock += 30_000;
  const second = await probe.run();

  // The whole safety property: an authorised caller in a retry loop cannot
  // drain a daily budget shared with the app's real AI features.
  assert.equal(calls.n, 1);
  assert.equal(second.cached, true);
  assert.equal(second.cachedAgeMs, 30_000);
  assert.equal(second.answer, "blue");
});

test("past the window it calls again — a stale success must not masquerade as fresh", async () => {
  const [fetchImpl, calls] = counting(() => ok("blue"));
  let clock = 1000;
  const probe = createLivenessProbe({
    chain: chain(),
    env: ENV,
    fetchImpl,
    minIntervalMs: 60_000,
    now: () => clock,
  });

  await probe.run();
  clock += 60_001;
  const second = await probe.run();

  assert.equal(calls.n, 2);
  assert.equal(second.cached, false);
});

test("a FAILURE is never cached — the point is the truth about right now", async () => {
  let mode = "down";
  const [fetchImpl, calls] = counting(() =>
    mode === "down" ? new Response("boom", { status: 500 }) : ok("blue"),
  );
  const probe = createLivenessProbe({
    chain: chain(),
    env: ENV,
    fetchImpl,
    minIntervalMs: 60_000,
    now: () => 1000,
  });

  const first = await probe.run();
  assert.equal(first.ok, false);
  assert.ok(first.failures.length > 0);

  // Vendor recovers. Caching the failure would keep reporting an outage that
  // is over — and the clock has NOT advanced, so only the no-cache-on-failure
  // rule can let this through.
  mode = "up";
  const second = await probe.run();
  assert.equal(second.ok, true);
  assert.equal(calls.n, 2);
});

test("no keys is reported as SKIPPED, not as a working chain", async () => {
  const probe = createLivenessProbe({ chain: [], env: {}, fetchImpl: async () => ok("x") });
  const r = await probe.run();
  assert.equal(r.ok, false);
  assert.match(r.skipped, /No usable link/);
});

test("handler: an ordinary poll does NOT probe and costs nothing", async () => {
  const [fetchImpl, calls] = counting(() => ok("blue"));
  const handler = createAiHealthHandler({ chain: chain(), env: ENV, fetchImpl, secret: "s" });

  const res = await handler(new Request("https://x.test/api/health/ai"));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.probed, false);
  assert.equal(calls.n, 0);
});

test("handler: probing without the secret is 401 and makes NO call", async () => {
  const [fetchImpl, calls] = counting(() => ok("blue"));
  const handler = createAiHealthHandler({ chain: chain(), env: ENV, fetchImpl, secret: "s" });

  const res = await handler(new Request("https://x.test/api/health/ai?probe=1"));
  assert.equal(res.status, 401);
  assert.equal(calls.n, 0);

  const wrong = await handler(
    new Request("https://x.test/api/health/ai?probe=1", { headers: { "x-probe-secret": "nope" } }),
  );
  assert.equal(wrong.status, 401);
  assert.equal(calls.n, 0);
});

test("handler: with no secret CONFIGURED, probing is off rather than open", async () => {
  const [fetchImpl, calls] = counting(() => ok("blue"));
  const handler = createAiHealthHandler({ chain: chain(), env: ENV, fetchImpl });

  const res = await handler(new Request("https://x.test/api/health/ai?probe=1&secret=anything"));
  const body = await res.json();

  // An app that forgot to set a secret must get a route that cannot spend
  // money, never an open endpoint that can.
  assert.equal(res.status, 501);
  assert.equal(calls.n, 0);
  assert.match(body.error, /not configured/);
});

test("handler: a good secret probes and returns 200 with the answer", async () => {
  const [fetchImpl] = counting(() => ok("blue"));
  const handler = createAiHealthHandler({ chain: chain(), env: ENV, fetchImpl, secret: "s" });

  const res = await handler(
    new Request("https://x.test/api/health/ai?probe=1", { headers: { "x-probe-secret": "s" } }),
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.probed, true);
  assert.equal(body.answer, "blue");
});

test("handler: a dead chain returns 503 so an uptime monitor can watch this URL", async () => {
  const handler = createAiHealthHandler({
    chain: chain(),
    env: ENV,
    fetchImpl: async () => new Response("boom", { status: 500 }),
    secret: "s",
  });

  const res = await handler(new Request("https://x.test/api/health/ai?probe=1&secret=s"));
  assert.equal(res.status, 503);
});

test("handler: a probe teaches passive health, so the next free poll knows", async () => {
  const health = createHealthTracker();
  const [fetchImpl] = counting(() => ok("blue"));
  const handler = createAiHealthHandler({
    chain: chain(),
    env: ENV,
    fetchImpl,
    secret: "s",
    health,
  });

  // Before: nothing has ever been recorded — indistinguishable from broken.
  assert.equal(health.getHealth().status, "unknown");

  await handler(new Request("https://x.test/api/health/ai?probe=1&secret=s"));

  assert.equal(health.getHealth().status, "ok");

  const passive = await handler(new Request("https://x.test/api/health/ai"));
  const body = await passive.json();
  assert.equal(body.health.status, "ok");
});
