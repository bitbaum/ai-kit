/**
 * One line per model call, for every app on a box (src/usage-log.ts).
 *
 * The incident this guards: about $567 at Google on 10-11 Nov 2026, and no way
 * to say which app spent it, on what, or when.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  walkChain,
  LinkFailure,
  setUsageSink,
  setSpendLedger,
  memorySpendLedger,
  emitUsage,
  readUsageDay,
  parseUsageLines,
  summariseUsage,
  usageDir,
  BOX_USAGE_DIR,
} from "@bitbaum/ai-kit";

afterEach(() => {
  setUsageSink(null);
  setSpendLedger(memorySpendLedger());
});

const groq = {
  id: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  keyEnv: "GROQ_API_KEY",
  models: ["a", "b"],
  dailyTokens: 1000,
};
const google = {
  id: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  keyEnv: "GEMINI_API_KEY",
  models: ["gemini"],
  dailyTokens: 1000,
};
const chain = [
  { provider: google, model: "gemini" },
  { provider: groq, model: "a" },
  { provider: groq, model: "b" },
];
const env = { GROQ_API_KEY: "g", GEMINI_API_KEY: "x", AI_APP_ID: "DEMO" };

test("the walk reports a refused, a failed and a served link, with the app and no content", async () => {
  const seen = [];
  setUsageSink((e) => seen.push(e));
  const result = await walkChain({ chain, env }, async (link) => {
    if (link.model === "a") throw new LinkFailure(link, "groq/a: 503", { status: 503 });
    return { usage: { prompt_tokens: 12, completion_tokens: 5 }, text: "secret answer" };
  });
  assert.equal(result.text, "secret answer");
  assert.deepEqual(
    seen.map((e) => [e.app, e.provider, e.model, e.outcome]),
    [
      ["DEMO", "google", "gemini", "refused"],
      ["DEMO", "groq", "a", "failed"],
      ["DEMO", "groq", "b", "served"],
    ],
  );
  assert.equal(seen[0].paid, true);
  assert.ok(seen[0].reason, "a refusal names the spend rule");
  assert.equal(seen[1].status, 503);
  assert.equal(typeof seen[1].ms, "number");
  assert.equal(seen[2].paid, false);
  assert.ok(!JSON.stringify(seen).includes("secret"), "never the answer");
});

test("with AI_USAGE_DIR set and no sink, each call is a line in the day's file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-usage-"));
  const t = Date.UTC(2026, 10, 13, 9, 0, 0);
  emitUsage(
    { t, app: "LOKI", provider: "groq", model: "a", outcome: "served", paid: false, byok: false },
    { AI_USAGE_DIR: dir },
  );
  emitUsage(
    {
      t: t + 1,
      app: "CAT",
      provider: "groq",
      model: "a",
      outcome: "failed",
      paid: false,
      byok: false,
      status: 429,
    },
    { AI_USAGE_DIR: dir },
  );
  await new Promise((r) => setTimeout(r, 100));
  const lines = readFileSync(join(dir, "2026-11-13.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const day = readUsageDay(dir, "2026-11-13");
  assert.deepEqual(day.map((e) => e.app).sort(), ["CAT", "LOKI"]);
});

test("could not look is null; a day with no calls is an empty list", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-usage-"));
  assert.deepEqual(readUsageDay(dir, "2026-11-12"), []);
  assert.equal(readUsageDay(join(dir, "missing"), "2026-11-12"), null);
  assert.equal(readUsageDay(dir, "../etc/passwd"), null);
});

test("a torn line is skipped, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-usage-"));
  const good = {
    t: 1,
    app: "A",
    provider: "groq",
    model: "m",
    outcome: "served",
    paid: false,
    byok: false,
  };
  writeFileSync(
    join(dir, "2026-11-13.jsonl"),
    `${JSON.stringify(good)}\n{"t":2,"app":"A","prov\nnot json\n{"t":3}\n`,
  );
  assert.equal(readUsageDay(dir, "2026-11-13").length, 1);
  assert.equal(parseUsageLines("").length, 0);
});

test("a sink that throws never costs the answer", async () => {
  setUsageSink(() => {
    throw new Error("disk full");
  });
  const result = await walkChain(
    { chain: [{ provider: groq, model: "a" }], env },
    async () => "ok",
  );
  assert.equal(result, "ok");
});

test("the summary says who used which vendor, and what last went wrong", () => {
  const e = (t, app, provider, model, outcome, more = {}) => ({
    t,
    app,
    provider,
    model,
    outcome,
    paid: provider === "google",
    byok: false,
    ...more,
  });
  const s = summariseUsage([
    e(1, "CAT", "groq", "a", "served", { inputTokens: 100, outputTokens: 20 }),
    e(2, "CAT", "groq", "a", "served", { inputTokens: 50, outputTokens: 10 }),
    e(3, "LOKI", "groq", "b", "failed", { status: 429, kind: "daily" }),
    e(4, "HEIDI", "google", "gemini", "served", { inputTokens: 900, outputTokens: 300 }),
    e(5, "CAT", "google", "gemini", "refused", { reason: "paid-not-opted-in" }),
    { ...e(6, "CAT", "xai", "grok", "served"), byok: true },
  ]);
  assert.equal(s.ownKeyCalls, 1);
  assert.equal(s.total.served, 3);
  assert.equal(s.total.failed, 1);
  assert.equal(s.total.refused, 1);
  assert.deepEqual(
    s.providers.map((p) => p.provider),
    ["groq", "google"],
  );
  const g = s.providers[0];
  assert.equal(g.paid, false);
  assert.deepEqual(
    g.apps.map((a) => [a.app, a.served, a.failed]),
    [
      ["CAT", 2, 0],
      ["LOKI", 0, 1],
    ],
  );
  assert.equal(g.inputTokens, 150);
  assert.deepEqual(g.lastProblem, { at: 3, outcome: "failed", status: 429, kind: "daily" });
  assert.equal(g.lastServedAt, 2);
  const goo = s.providers[1];
  assert.equal(goo.paid, true);
  assert.deepEqual(goo.apps.map((a) => a.app).sort(), ["CAT", "HEIDI"]);
  assert.deepEqual(
    s.apps.map((a) => a.app),
    ["CAT", "LOKI", "HEIDI"],
  );
  assert.deepEqual(
    s.apps[0].providers.map((p) => p.provider),
    ["groq", "google"],
  );
  assert.equal(s.from, 1);
  assert.equal(s.to, 6);
  assert.equal(summariseUsage([]).from, null);
});

test("usageDir: the variable wins, `off` writes nowhere, unset falls back to the box's directory only if it exists", () => {
  assert.equal(usageDir({ AI_USAGE_DIR: " /tmp/x " }), "/tmp/x");
  for (const off of ["off", "OFF", "0", "false", "no"]) {
    assert.equal(usageDir({ AI_USAGE_DIR: off }), null, off);
  }
  const fallback = usageDir({});
  assert.equal(fallback, existsSync(BOX_USAGE_DIR) ? BOX_USAGE_DIR : null);
  assert.equal(BOX_USAGE_DIR, "/opt/fleet/ai-usage");
});

test("a call says what it was for, and the summary groups each app's calls by it", async () => {
  const seen = [];
  setUsageSink((e) => seen.push(e));
  await walkChain({ chain, env, feature: "law-translate" }, async (link) => {
    if (link.model === "a") throw new LinkFailure(link, "groq/a: 429", { status: 429 });
    return { text: "ok" };
  });
  assert.deepEqual(
    seen.map((e) => [e.outcome, e.feature]),
    [
      ["refused", "law-translate"],
      ["failed", "law-translate"],
      ["served", "law-translate"],
    ],
  );
  const unnamed = {
    t: 9,
    app: "DEMO",
    provider: "groq",
    model: "a",
    outcome: "served",
    paid: false,
    byok: false,
  };
  const s = summariseUsage([...seen, unnamed, { ...unnamed, feature: "chat" }]);
  const demo = s.apps.find((a) => a.app === "DEMO");
  assert.deepEqual(
    demo.features.map((f) => [f.feature, f.served, f.failed, f.refused]),
    [
      ["law-translate", 1, 1, 1],
      ["chat", 1, 0, 0],
    ],
  );
  assert.equal(demo.served, 3, "a call that named nothing still counts for its app");
});

test("no feature named, no feature written", async () => {
  const seen = [];
  setUsageSink((e) => seen.push(e));
  await walkChain({ chain: [{ provider: groq, model: "b" }], env }, async () => ({ text: "ok" }));
  assert.equal("feature" in seen[0], false);
});
