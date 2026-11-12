/**
 * The chain's job is to never be a single point of failure, and to never ration
 * users against capacity that cannot be reached. Both are pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  freeChain,
  withEnvPrefix,
  providerModels,
  dayCapacityTokens,
  usableChain,
  chainFrom,
} from "@bitbaum/ai-kit";

const CHAIN = freeChain("LOKI");

test("the default chain spans MORE THAN ONE VENDOR — the entire point", () => {
  const vendors = new Set(CHAIN.map((p) => p.id));
  assert.ok(vendors.size >= 2, `a one-vendor chain is a pin with extra steps: ${[...vendors]}`);
});

test("every default model is free or explicitly a free-tier id", () => {
  // A paid id sneaking into a chain named "free" is how a fallback quietly
  // starts billing. Groq's free tier is account-level (its ids carry no marker),
  // so the rule is applied where it is checkable: OpenRouter ids must be :free.
  const openrouter = CHAIN.find((p) => p.id === "openrouter");
  for (const model of openrouter.models) {
    assert.ok(
      model.endsWith(":free") || model === "openrouter/free",
      `paid OpenRouter model in the free chain: ${model}`,
    );
  }
});

test("capacity counts ONLY vendors we hold a key for", () => {
  assert.equal(dayCapacityTokens(CHAIN, {}), 0, "unkeyed vendors contributed capacity");

  const groqOnly = dayCapacityTokens(CHAIN, { GROQ_API_KEY: "x" });
  assert.equal(groqOnly, CHAIN.find((p) => p.id === "groq").dailyTokens);

  // Keys derived from the chain rather than listed, so adding a vendor cannot
  // silently turn "all keyed" into "some keyed". The previous version of this
  // assertion hard-coded two key names and compared against the sum over EVERY
  // provider — which was the same thing only while the chain had exactly two,
  // and broke the moment a third was added.
  const allKeys = Object.fromEntries(CHAIN.map((p) => [p.keyEnv, "x"]));
  assert.equal(
    dayCapacityTokens(CHAIN, allKeys),
    CHAIN.reduce((n, p) => n + p.dailyTokens, 0),
    "capacity must SUM across vendors",
  );

  // The half that only became testable with a third vendor present: a keyed
  // subset must contribute exactly its own capacity, not the whole chain's.
  const [first, second] = CHAIN;
  assert.equal(
    dayCapacityTokens(CHAIN, { [first.keyEnv]: "x", [second.keyEnv]: "y" }),
    first.dailyTokens + second.dailyTokens,
    "an unkeyed vendor must contribute nothing to the total",
  );
});

test("an env override recalibrates a budget without a deploy, and junk falls back", () => {
  assert.equal(
    dayCapacityTokens(CHAIN, { GROQ_API_KEY: "x", LOKI_GROQ_DAILY_TOKENS: "12345" }),
    12_345,
  );
  assert.equal(
    dayCapacityTokens(CHAIN, { GROQ_API_KEY: "x", LOKI_GROQ_DAILY_TOKENS: "nonsense" }),
    CHAIN.find((p) => p.id === "groq").dailyTokens,
    "a junk override must fall back, not zero the budget",
  );
});

test("a rotted model can be routed around by env alone", () => {
  const groq = CHAIN.find((p) => p.id === "groq");
  assert.deepEqual(providerModels(groq, { LOKI_GROQ_MODELS: "a, b  c" }), ["a", "b", "c"]);
  assert.deepEqual(providerModels(groq, {}), groq.models, "no override must keep the shipped list");
  assert.deepEqual(
    providerModels(groq, { LOKI_GROQ_MODELS: "   " }),
    groq.models,
    "a blank override is not a wipe",
  );
});

test("usableChain silently drops vendors with no key", () => {
  const links = usableChain(CHAIN, { GROQ_API_KEY: "x" });
  assert.ok(links.length > 0);
  assert.ok(
    links.every((l) => l.provider.id === "groq"),
    "an unkeyed vendor leaked into the chain",
  );
});

test("a pinned model is a STARTING POINT, never a hard pin", () => {
  const links = usableChain(CHAIN, { GROQ_API_KEY: "x", OPENROUTER_API_KEY: "y" });
  const pinned = chainFrom("openai/gpt-oss-20b:free", links);
  assert.equal(pinned[0].model, "openai/gpt-oss-20b:free");
  assert.ok(pinned.length > 1, "pinning a model must not remove its fallbacks");
});

test("an unknown model is tried, then falls through to the ordinary chain", () => {
  const links = usableChain(CHAIN, { GROQ_API_KEY: "x" });
  const out = chainFrom("some/just-released-id", links);
  assert.equal(
    out[0].model,
    "some/just-released-id",
    "an unadvertised id is still a legitimate request",
  );
  assert.equal(out.length, links.length + 1, "it must not dead-end the chain");
});

test("chainFrom on an empty chain returns empty rather than inventing a link", () => {
  assert.deepEqual(chainFrom("anything", []), []);
});

test("withEnvPrefix derives both override names from the provider id", () => {
  const p = withEnvPrefix("APP", {
    id: "my-vendor",
    baseUrl: "https://x",
    keyEnv: "K",
    models: ["m"],
    dailyTokens: 1,
  });
  assert.equal(p.modelsEnv, "APP_MY_VENDOR_MODELS");
  assert.equal(p.dailyTokensEnv, "APP_MY_VENDOR_DAILY_TOKENS");
});

test("Google is not in the free chain: it bills (about $567 on 10-11 Nov 2026)", () => {
  // It sat second, on a fleet-wide GEMINI_API_KEY, described as a free
  // per-project tier. The project had billing.
  for (const prefix of ["AI", "LOKI", "HEIDI", "SOLON", "SUBSTRATA", "ANY_APP"]) {
    const chain = freeChain(prefix);
    assert.ok(!chain.some((p) => p.id === "google"), `${prefix}: google is back in the chain`);
    assert.ok(
      !chain.some((p) => /googleapis|GEMINI|GOOGLE_API/i.test(`${p.baseUrl} ${p.keyEnv}`)),
      `${prefix}: a Google endpoint or key is back in the chain`,
    );
  }
});

test("GEMINI_API_KEY in the environment yields no Google link", () => {
  const env = {
    GROQ_API_KEY: "g",
    OPENROUTER_API_KEY: "o",
    GEMINI_API_KEY: "set-on-the-box",
    GOOGLE_API_KEY: "set-on-the-box",
  };
  const links = usableChain(freeChain("HEIDI"), env);
  assert.ok(links.length > 0);
  assert.ok(
    !links.some((l) => /google/i.test(l.provider.id) || /googleapis/.test(l.provider.baseUrl)),
  );
});

test("the default chain is free providers only: Groq, then OpenRouter :free last", () => {
  assert.deepEqual(
    CHAIN.map((p) => p.id),
    ["groq", "openrouter"],
  );
});

test("OpenRouter is LAST, because its 50/day is the scarcest pool", () => {
  // Ordering is capacity, not preference. OpenRouter's unpaid tier is 50
  // REQUESTS a day for the whole ACCOUNT — and on a shared box that account is
  // shared too — so every other pool is drained before one of those is spent.
  assert.equal(
    CHAIN[CHAIN.length - 1].id,
    "openrouter",
    "OpenRouter must be the last link in the free chain",
  );
});
