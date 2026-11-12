/**
 * Paid AI is off unless a feature opts in, and capped when it does (src/spend.ts).
 *
 * The incident this guards: a fleet-wide GEMINI_API_KEY sat second in the
 * free chain and billed about $567 on 10-11 Nov 2026. The owner's ceiling is
 * CHF 10 a month across every provider; these caps keep the fleet well under.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  complete,
  freeChain,
  usableChain,
  isPaidProvider,
  paidDisabled,
  paidAllowed,
  appPaidCaps,
  fleetPaidCaps,
  xaiCaps,
  freeCallCap,
  canonicalApp,
  setSpendLedger,
  memorySpendLedger,
  SpendLimitError,
  APP_DAILY_PAID,
  FLEET_DAILY_PAID,
} from "@bitbaum/ai-kit";

beforeEach(() => {
  setSpendLedger(memorySpendLedger());
});

const paid = (id, baseUrl, keyEnv, extra = {}) => ({
  id,
  baseUrl,
  keyEnv,
  models: [`${id}-model`],
  dailyTokens: 1000,
  ...extra,
});
const xai = paid("xai", "https://api.x.ai/v1", "XAI_API_KEY", { envPrefix: "LOKI" });
const anthropic = paid("anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY", {
  envPrefix: "HEIDI",
});
const freeGroq = {
  id: "groq",
  baseUrl: "https://groq.invalid/v1",
  keyEnv: "GROQ_API_KEY",
  models: ["free-model"],
  dailyTokens: 1000,
  envPrefix: "HEIDI",
};

function ok(text) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200 },
  );
}
const fetchAll = (calls) => async (_url, init) => {
  calls.push(JSON.parse(init.body).model);
  return ok("hi");
};
const msg = [{ role: "user", content: "hi" }];

// ── the kill switch ──────────────────────────────────────────────────────────

test("kill switch: missing means ON (no paid call)", () => {
  assert.equal(paidDisabled({}), true);
  assert.equal(paidAllowed("HEIDI", { AI_PAID_OK: "1" }), false, "opt-in alone is not enough");
});

test("kill switch: on", () => {
  for (const v of ["1", "true", "on", "yes", "anything"]) {
    assert.equal(paidDisabled({ AI_PAID_DISABLED: v }), true, v);
  }
});

test("kill switch: off, and only then does an opt-in count", () => {
  for (const v of ["0", "false", "off", "no"]) {
    assert.equal(paidDisabled({ AI_PAID_DISABLED: v }), false, v);
  }
  assert.equal(paidAllowed("HEIDI", { AI_PAID_DISABLED: "0" }), false, "no opt-in");
  assert.equal(paidAllowed("HEIDI", { AI_PAID_DISABLED: "0", AI_PAID_OK: "1" }), true);
  assert.equal(paidAllowed("HEIDI", { AI_PAID_DISABLED: "0", HEIDI_AI_PAID_OK: "true" }), true);
  assert.equal(paidAllowed("SOLON", { AI_PAID_DISABLED: "0", HEIDI_AI_PAID_OK: "true" }), false);
});

// ── no paid provider unless opted in ─────────────────────────────────────────

test("which providers are paid", () => {
  assert.equal(isPaidProvider(xai), true);
  assert.equal(isPaidProvider(anthropic), true);
  assert.equal(
    isPaidProvider(
      paid("google", "https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"),
    ),
    true,
  );
  assert.equal(isPaidProvider(paid("solon-g", "https://x.invalid", "SOLON_GEMINI_API_KEY")), true);
  assert.equal(isPaidProvider(paid("grok", "https://x.invalid", "GROK_DEPLOYMENT_KEY")), true);
  assert.equal(isPaidProvider({ ...xai, byok: true }), false, "a reader's own key is theirs");
  for (const p of freeChain("ANY")) assert.equal(isPaidProvider(p), false, p.id);
});

test("xAI keys set but no AI_PAID_OK: no xAI link, and no call", async () => {
  const env = {
    XAI_API_KEY: "x",
    GROK_API_KEY: "x",
    GROK_DEPLOYMENT_KEY: "x",
    AI_PAID_DISABLED: "0",
  };
  assert.deepEqual(usableChain([xai], env), []);
  const calls = [];
  await assert.rejects(
    complete({
      chain: [{ provider: xai, model: "xai-model" }],
      env,
      messages: msg,
      fetchImpl: fetchAll(calls),
    }),
    (e) => e instanceof SpendLimitError && /has not opted in/.test(e.message),
  );
  assert.deepEqual(calls, []);
});

test("AI_PAID_DISABLED on or missing blocks xAI even with AI_PAID_OK", async () => {
  for (const env of [
    { XAI_API_KEY: "x", AI_PAID_OK: "1" },
    { XAI_API_KEY: "x", AI_PAID_OK: "1", AI_PAID_DISABLED: "1" },
  ]) {
    assert.deepEqual(usableChain([xai], env), []);
    const calls = [];
    await assert.rejects(
      complete({
        chain: [{ provider: xai, model: "xai-model" }],
        env,
        messages: msg,
        fetchImpl: fetchAll(calls),
      }),
      (e) => e instanceof SpendLimitError && /switched off/.test(e.message),
    );
    assert.deepEqual(calls, []);
  }
});

// ── caps ─────────────────────────────────────────────────────────────────────

test("the defaults: fleet 90 / 120,000 in / 60,000 out", () => {
  assert.deepEqual(fleetPaidCaps({}), { calls: 90, inputTokens: 120_000, outputTokens: 60_000 });
  assert.deepEqual(fleetPaidCaps({ AI_FLEET_DAILY_PAID_CALLS: "10" }).calls, 10);
});

test("named caps leave fleet headroom (about 60% named)", () => {
  const rows = Object.values(APP_DAILY_PAID);
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  // SBB is one row with two names, so it counts once.
  assert.equal(sum("calls"), 51);
  assert.equal(sum("inputTokens"), 71_800);
  assert.equal(sum("outputTokens"), 35_900);
  assert.ok(sum("calls") < FLEET_DAILY_PAID.calls);
  assert.ok(sum("inputTokens") < FLEET_DAILY_PAID.inputTokens);
  assert.ok(sum("outputTokens") < FLEET_DAILY_PAID.outputTokens);
});

test("rows, aliases, unknown and no-AI apps", () => {
  assert.deepEqual(appPaidCaps("ORANGECAT", {}), {
    calls: 15,
    inputTokens: 22_000,
    outputTokens: 11_000,
  });
  assert.deepEqual(appPaidCaps("solon", {}), { calls: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(appPaidCaps("openclaw", {}), { calls: 0, inputTokens: 0, outputTokens: 0 });
  for (const [alias, canon] of [
    ["aoz-wohnen", "AOZ"],
    ["AOZ_BEGLEITUNG", "AOZ"],
    ["revamp-info", "HIRNLI"],
    ["Revampit", "EVIG"],
    ["sbb-fundbuero", "SBB"],
    ["surf-your-life", "SURF_YOUR_LIFE"],
    ["center-com", "CENTER_COM"],
  ]) {
    assert.equal(canonicalApp(alias), canon, alias);
  }
  assert.deepEqual(appPaidCaps("aoz-wohnen", {}), {
    calls: 1,
    inputTokens: 1_200,
    outputTokens: 600,
  });
  assert.deepEqual(appPaidCaps("SBB", {}), { calls: 1, inputTokens: 800, outputTokens: 400 });
  assert.deepEqual(
    appPaidCaps("sink", {}),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
    "s-ink has no AI",
  );
  assert.deepEqual(appPaidCaps("petvity", {}), { calls: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(appPaidCaps("some-new-app", {}), {
    calls: 1,
    inputTokens: 800,
    outputTokens: 400,
  });
  assert.deepEqual(
    appPaidCaps(undefined, {}),
    { calls: 1, inputTokens: 800, outputTokens: 400 },
    "never unlimited",
  );
});

test("per-app env overrides: canonical prefix and the app's own", () => {
  assert.equal(appPaidCaps("HEIDI", { HEIDI_DAILY_PAID_CALLS: "3" }).calls, 3);
  assert.equal(appPaidCaps("aoz-wohnen", { AOZ_DAILY_PAID_CALLS: "2" }).calls, 2);
  assert.equal(
    appPaidCaps("aoz-wohnen", { AOZ_DAILY_PAID_CALLS: "2", AOZ_WOHNEN_DAILY_PAID_CALLS: "4" })
      .calls,
    4,
  );
  assert.equal(
    appPaidCaps("HEIDI", { HEIDI_DAILY_PAID_CALLS: "nonsense" }).calls,
    9,
    "junk is ignored",
  );
});

test("xAI: 0 by default; a small cap once opted in, tighter by env", () => {
  assert.deepEqual(xaiCaps("LOKI", {}), { calls: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(xaiCaps("LOKI", { AI_PAID_OK: "1" }), {
    calls: 2,
    inputTokens: 2_000,
    outputTokens: 1_000,
  });
  assert.equal(xaiCaps("LOKI", { LOKI_AI_PAID_OK: "1", LOKI_DAILY_XAI_CALLS: "1" }).calls, 1);
});

test("an opted-in xAI cap binds, with a clear error and no walk to another paid vendor", async () => {
  const env = { XAI_API_KEY: "x", ANTHROPIC_API_KEY: "a", AI_PAID_DISABLED: "0", AI_PAID_OK: "1" };
  const anth = { ...anthropic, envPrefix: "LOKI" };
  const chain = [
    { provider: xai, model: "xai-model" },
    { provider: anth, model: "anthropic-model" },
  ];
  const calls = [];
  await complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) });
  await complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) });
  assert.deepEqual(calls, ["xai-model", "xai-model"]);
  await assert.rejects(
    complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) }),
    (e) =>
      e instanceof SpendLimitError &&
      /limit reached/.test(e.message) &&
      /xAI allowance/.test(e.message),
  );
  assert.deepEqual(calls, ["xai-model", "xai-model"], "did not walk to anthropic");
});

test("an app cap binds; a free link after it still serves", async () => {
  const env = {
    ANTHROPIC_API_KEY: "a",
    GROQ_API_KEY: "g",
    AI_PAID_DISABLED: "0",
    AI_PAID_OK: "1",
    HEIDI_DAILY_PAID_CALLS: "1",
  };
  const chain = [
    { provider: anthropic, model: "anthropic-model" },
    { provider: freeGroq, model: "free-model" },
  ];
  const calls = [];
  await complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) });
  const second = await complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) });
  assert.deepEqual(calls, ["anthropic-model", "free-model"]);
  assert.equal(second.link.provider.id, "groq");
});

test("the fleet cap binds even when the app has room", async () => {
  const env = {
    ANTHROPIC_API_KEY: "a",
    AI_PAID_DISABLED: "0",
    AI_PAID_OK: "1",
    AI_FLEET_DAILY_PAID_CALLS: "1",
  };
  const chain = [{ provider: anthropic, model: "anthropic-model" }];
  const calls = [];
  await complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) });
  await assert.rejects(
    complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) }),
    (e) => e instanceof SpendLimitError && /fleet's daily paid allowance/.test(e.message),
  );
});

test("output tokens count: a spent token allowance stops the next call", async () => {
  const env = {
    ANTHROPIC_API_KEY: "a",
    AI_PAID_DISABLED: "0",
    AI_PAID_OK: "1",
    HEIDI_DAILY_PAID_OUTPUT_TOKENS: "40",
  };
  const chain = [{ provider: anthropic, model: "anthropic-model" }];
  const calls = [];
  await complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) });
  await assert.rejects(
    complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) }),
    SpendLimitError,
  );
});

test("BYOK still works when the platform's paid caps are spent", async () => {
  const env = {
    ANTHROPIC_API_KEY: "a",
    READER_KEY: "r",
    AI_PAID_DISABLED: "0",
    AI_PAID_OK: "1",
    AI_FLEET_DAILY_PAID_CALLS: "0",
  };
  const own = { ...anthropic, id: "own", keyEnv: "READER_KEY", byok: true };
  const calls = [];
  const r = await complete({
    chain: [
      { provider: anthropic, model: "anthropic-model" },
      { provider: own, model: "own-model" },
    ],
    env,
    messages: msg,
    fetchImpl: fetchAll(calls),
  });
  assert.equal(r.link.provider.id, "own");
  assert.deepEqual(calls, ["own-model"]);
});

test("free calls do not count against paid caps, but a loop guard stops a runaway", async () => {
  assert.equal(freeCallCap("HEIDI", {}), 5_000);
  const env = { GROQ_API_KEY: "g", HEIDI_DAILY_FREE_CALLS: "2" };
  const chain = [{ provider: freeGroq, model: "free-model" }];
  const calls = [];
  await complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) });
  await complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) });
  await assert.rejects(
    complete({ chain, env, messages: msg, fetchImpl: fetchAll(calls) }),
    (e) => e instanceof SpendLimitError && /loop guard/.test(e.message),
  );
  assert.equal(calls.length, 2);
});
