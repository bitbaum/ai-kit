/**
 * The chain is itself a list of pins, so it rots. These tests pin the part that
 * is easy to get subtly wrong: telling "the vendor retired this" apart from
 * "I could not read the catalogue". Conflating them either invents an outage or
 * hides one.
 *
 * No network and no keys — fetch is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkCatalog, hasRot, deadProviders, catalogReport, withEnvPrefix } from "@bitbaum/ai-kit";

const provider = (id, models, keyEnv) =>
  withEnvPrefix("T", { id, baseUrl: `https://${id}.test/v1`, keyEnv, models, dailyTokens: 1000 });

/** A fetch that serves a fixed catalogue, or a status, per host. */
const fakeFetch = (byHost) => async (url) => {
  const host = new URL(url).host;
  const entry = byHost[host];
  if (entry === undefined) return { ok: false, status: 404, json: async () => ({}) };
  if (typeof entry === "number") return { ok: false, status: entry, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ data: entry.map((id) => ({ id })) }) };
};

const ENV = { T_GROQ_API_KEY: "k", GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k" };

test("a retired id is reported GONE, a live one is not", async () => {
  const chain = [provider("groq", ["alive-1", "retired-1"], "GROQ_API_KEY")];
  const v = await checkCatalog(chain, {
    env: ENV,
    fetchImpl: fakeFetch({ "groq.test": ["alive-1", "something-else"] }),
  });
  assert.deepEqual(v[0].present, ["alive-1"]);
  assert.deepEqual(v[0].missing, ["retired-1"]);
  assert.equal(hasRot(v), true);
});

test("an unreadable catalogue is UNCHECKED — never reported as rot", async () => {
  // This is the failure that matters most. A 500, a network blip or a missing
  // key must not make every pinned model look retired.
  const chain = [provider("groq", ["a", "b"], "GROQ_API_KEY")];
  const v = await checkCatalog(chain, { env: ENV, fetchImpl: fakeFetch({ "groq.test": 500 }) });
  assert.equal(v[0].live, null);
  assert.deepEqual(v[0].missing, []);
  assert.deepEqual(v[0].unchecked, ["a", "b"]);
  assert.equal(hasRot(v), false, "a failed lookup was reported as retired models");
});

test("no API key is UNCHECKED, not a pass and not an outage", async () => {
  const chain = [provider("groq", ["a"], "MISSING_KEY_ENV")];
  const v = await checkCatalog(chain, { env: {}, fetchImpl: fakeFetch({ "groq.test": ["a"] }) });
  assert.equal(v[0].live, null);
  assert.deepEqual(v[0].unchecked, ["a"]);
  assert.equal(hasRot(v), false);
  assert.match(catalogReport(v), /UNCHECKED/);
  assert.match(catalogReport(v), /not a pass/);
});

test("a catalogue that parses but lists nothing is unreadable, not total rot", async () => {
  const chain = [provider("groq", ["a"], "GROQ_API_KEY")];
  const v = await checkCatalog(chain, { env: ENV, fetchImpl: fakeFetch({ "groq.test": [] }) });
  assert.equal(v[0].live, null, "an empty catalogue was believed");
  assert.equal(hasRot(v), false);
});

test("a vendor whose every model is gone is named — the chain lost a link", async () => {
  // The 2026-08-25 case: both Groq ids retired, so the "fallback chain" led
  // with a vendor that could never answer.
  const chain = [
    provider("groq", ["gone-1", "gone-2"], "GROQ_API_KEY"),
    provider("openrouter", ["ok-1", "gone-3"], "OPENROUTER_API_KEY"),
  ];
  const v = await checkCatalog(chain, {
    env: ENV,
    fetchImpl: fakeFetch({ "groq.test": ["other"], "openrouter.test": ["ok-1"] }),
  });
  assert.deepEqual(deadProviders(v), ["groq"]);
  assert.match(catalogReport(v), /EVERY model is gone at: groq/);
  // openrouter is degraded, not dead — it must NOT be listed.
  assert.ok(!deadProviders(v).includes("openrouter"));
});

test("an env override is what gets checked — not the library default", async () => {
  // Checking the defaults would give a clean report on a box the operator has
  // already routed around, and miss the ids it actually calls.
  const chain = [provider("groq", ["default-model"], "GROQ_API_KEY")];
  const env = { ...ENV, T_GROQ_MODELS: "override-model" };
  const v = await checkCatalog(chain, {
    env,
    fetchImpl: fakeFetch({ "groq.test": ["default-model"] }),
  });
  assert.deepEqual(v[0].missing, ["override-model"], "checked the default instead of the override");
});
