/**
 * Three things that decide how long a reader waits for the first word, each
 * measured live on 2026-09-25 before it was written down:
 *
 *  1. a daily refusal that names its model condemns that link, not the vendor
 *     (Groq meters its day per model);
 *  2. a cooldown honours the wait the refusal names, daily ones included
 *     (Groq's "per day" is a rolling 24 hours, not a UTC day);
 *  3. `reasoning: "light"` reaches only the links with a probed setting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  complete,
  createLinkCooldown,
  LinkFailure,
  namesModel,
  reasoningBody,
} from "@bitbaum/ai-kit";

const ENV = { GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" };
const provider = (id, keyEnv, models) => ({
  id,
  baseUrl: `https://${id}.invalid/v1`,
  keyEnv,
  models,
  dailyTokens: 1000,
});
const groq = provider("groq", "GROQ_API_KEY", ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
const or = provider("openrouter", "OPENROUTER_API_KEY", ["free"]);
const chain = () => [
  { provider: groq, model: "openai/gpt-oss-120b" },
  { provider: groq, model: "qwen/qwen3.8-27b" },
  { provider: or, model: "free" },
];
const ok = (text) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

function fakeFetch(table, calls, bodies = []) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    bodies.push(body);
    return table[body.model]();
  };
}

test("a daily refusal naming its model skips that link only — the vendor's next model is tried", async () => {
  const calls = [];
  const daily = JSON.stringify({
    error: {
      message:
        "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199669, Requested 900. Please try again in 2m5s.",
    },
  });
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch(
      {
        "openai/gpt-oss-120b": () => new Response(daily, { status: 429 }),
        "qwen/qwen3.8-27b": () => ok("served"),
        free: () => ok("wrong"),
      },
      calls,
    ),
  });
  assert.deepEqual(calls, ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
  assert.equal(result.text, "served");
});

test("namesModel needs the id quoted, so a prose mention does not narrow the verdict", () => {
  assert.equal(namesModel("for model `a/b` on tokens per day", "a/b"), true);
  assert.equal(namesModel('model "a/b" limit', "a/b"), true);
  assert.equal(namesModel("tokens per day for this organization", "a/b"), false);
  assert.equal(namesModel("groq/a/b: 429 daily", "a/b"), false);
});

test("a cooldown honours the wait a daily refusal names, and falls back to midnight without one", () => {
  let t = Date.UTC(2026, 8, 25, 0, 14, 0);
  const cd = createLinkCooldown({ now: () => t });
  const [a, b] = chain();
  cd.record(a, new LinkFailure(a, "429", { status: 429, kind: "daily", retryAfter: 180 }));
  cd.record(b, new LinkFailure(b, "429", { status: 429, kind: "daily" }));
  assert.deepEqual(
    cd.filter([a, b, chain()[2]]).map((l) => l.model),
    ["free"],
  );
  t += 181_000;
  assert.deepEqual(
    cd.filter([a, b]).map((l) => l.model),
    ["openai/gpt-oss-120b"],
    "the rolling window freed a; b named no wait and stays out until UTC midnight",
  );
  t = Date.UTC(2026, 8, 26, 0, 0, 1);
  assert.equal(cd.filter([a, b]).length, 2);
});

test('reasoning "light" is sent only to links with a probed setting', async () => {
  const [gptOss, qwen, free] = chain();
  assert.deepEqual(reasoningBody(gptOss, "light"), { reasoning_effort: "low" });
  assert.deepEqual(reasoningBody(qwen, "light"), {}, "Groq Qwen3 400s on low");
  assert.deepEqual(reasoningBody(free, "light"), {});
  assert.deepEqual(reasoningBody(gptOss, undefined), {});

  const calls = [];
  const bodies = [];
  await complete({
    chain: chain(),
    env: ENV,
    reasoning: "light",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ "openai/gpt-oss-120b": () => ok("x") }, calls, bodies),
  });
  assert.equal(bodies[0].reasoning_effort, "low");
});
