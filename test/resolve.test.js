/**
 * Resolution decides, at call time, which ids are worth trying — so the tests
 * that matter are the ones where a wrong decision costs something real:
 *
 *   - shrinking the chain because a KEY expired (an outage invented from
 *     ignorance — the exact mistake made while building this module),
 *   - putting an unproven model ahead of a curated one,
 *   - discovering a model that BILLS.
 *
 * The last one is the only failure here with an invoice attached, so it is
 * tested from several directions.
 *
 * No network and no keys — fetch is injected. Catalogue bodies mirror the real
 * schemas, which are NOT the same shape at both vendors; that difference is
 * itself under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveChain,
  applyResolution,
  routedAroundRot,
  emptyProviders,
  resolutionReport,
  withEnvPrefix,
} from "@bitbaum/ai-kit";

const provider = (id, models, keyEnv = "K") =>
  withEnvPrefix("T", { id, baseUrl: `https://${id}.test/v1`, keyEnv, models, dailyTokens: 1000 });

/** An OpenRouter-shaped record. */
const or = (id, opts = {}) => ({
  id,
  architecture: { output_modalities: opts.out ?? ["text"] },
  pricing: { prompt: opts.price ?? "0", completion: opts.price ?? "0" },
  supported_parameters: opts.tools === false ? ["temperature"] : ["tools", "temperature"],
  context_length: opts.ctx ?? 100000,
  ...(opts.expires ? { expiration_date: opts.expires } : {}),
});

/** A Groq-shaped record: modalities at the top level, features not parameters. */
const groq = (id, opts = {}) => ({
  id,
  output_modalities: opts.out ?? ["text"],
  pricing: { prompt: opts.price ?? "0.00000004", completion: opts.price ?? "0.00000004" },
  supported_features: opts.tools === false ? ["json_mode"] : ["tools"],
  context_length: opts.ctx ?? 100000,
});

const serve = (byHost) => async (url) => {
  const host = new URL(url).host;
  const entry = byHost[host];
  if (entry === undefined) return { ok: false, status: 404, json: async () => ({}) };
  if (typeof entry === "number") return { ok: false, status: entry, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ data: entry }) };
};

const ENV = { K: "key" };

test("a retired id is dropped and the live ones still run", async () => {
  const chain = [provider("v", ["alive", "retired"])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    discover: false,
    fetchImpl: serve({ "v.test": [or("alive")] }),
  });
  assert.deepEqual(r.kept, ["alive"]);
  assert.deepEqual(r.dropped, ["retired"]);
  assert.deepEqual(r.models, ["alive"]);
  assert.equal(routedAroundRot([r]), true);
});

test("an unreadable catalogue changes NOTHING and admits it", async () => {
  // The failure this module was nearly shipped with. A checkout missing its key
  // got a 401, and the first draft printed GONE for two models that were live.
  // Ignorance must never shrink the chain.
  for (const bad of [401, 500, 404]) {
    const chain = [provider("v", ["a", "b"])];
    const [r] = await resolveChain(chain, { env: ENV, fetchImpl: serve({ "v.test": bad }) });
    assert.equal(r.unverified, true, `status ${bad}`);
    assert.deepEqual(r.models, ["a", "b"], `status ${bad} must keep the declaration`);
    assert.deepEqual(r.dropped, [], `status ${bad} must confirm nothing gone`);
  }
});

test("a missing key is could-not-look, not an empty vendor", async () => {
  const chain = [provider("v", ["a"])];
  const [r] = await resolveChain(chain, { env: {}, fetchImpl: serve({ "v.test": [or("a")] }) });
  assert.equal(r.unverified, true);
  assert.deepEqual(r.models, ["a"]);
  assert.deepEqual(emptyProviders([r]), [], "unverified is not the same as empty");
});

test("discovery NEVER outranks a declared model", async () => {
  // Declared ids were probed with a real tool call; discovered ones have no
  // such evidence. They may be a last resort, never a first choice.
  const chain = [provider("v", ["curated"])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    fetchImpl: serve({ "v.test": [or("aaa-sorts-first"), or("curated")] }),
  });
  assert.equal(r.models[0], "curated");
  assert.deepEqual(r.discovered, ["aaa-sorts-first"]);
});

test("a model that BILLS is never discovered", async () => {
  const chain = [provider("v", [])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    fetchImpl: serve({
      "v.test": [or("free-one"), or("paid-one", { price: "0.00000003" })],
    }),
  });
  assert.deepEqual(r.discovered, ["free-one"]);
});

test("a model with NO published price is never discovered", async () => {
  // Silence is refused rather than assumed. Guessing wrong here spends money.
  const chain = [provider("v", [])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    fetchImpl: serve({
      "v.test": [
        {
          id: "unpriced",
          architecture: { output_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    }),
  });
  assert.deepEqual(r.discovered, []);
});

test("a whole vendor of paid models yields no discoveries at all", async () => {
  // Groq's real catalogue on 2026-09-13: every model priced above zero. So a
  // price-based filter finds nothing there and that vendor stays curated —
  // which is the correct, safe outcome, not a bug.
  const chain = [provider("groq", ["openai/gpt-oss-120b"])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    fetchImpl: serve({ "groq.test": [groq("openai/gpt-oss-120b"), groq("qwen/qwen3.8-27b")] }),
  });
  assert.deepEqual(r.kept, ["openai/gpt-oss-120b"], "Groq's own schema must parse");
  assert.deepEqual(r.discovered, [], "nothing at this vendor is free");
});

test("a classifier and an audio model are not offered as chat", async () => {
  // Both real: `nemotron-3.5-content-safety` was the only one of 19 free
  // OpenRouter ids declaring tools:false, and the `lyria-3-*` pair are
  // zero-priced but emit audio. Free is not the same question as usable.
  const chain = [provider("v", [])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    fetchImpl: serve({
      "v.test": [
        or("chat-model"),
        or("safety-classifier", { tools: false }),
        or("music-model", { out: ["text", "audio"] }),
      ],
    }),
  });
  assert.deepEqual(r.discovered, ["chat-model"]);
});

test("requirements can be relaxed deliberately", async () => {
  const chain = [provider("v", [])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    require: { tools: false },
    fetchImpl: serve({ "v.test": [or("no-tools", { tools: false })] }),
  });
  assert.deepEqual(r.discovered, ["no-tools"]);
});

test("minContext filters on the vendor's published window", async () => {
  const chain = [provider("v", [])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    require: { minContext: 200000 },
    fetchImpl: serve({ "v.test": [or("small", { ctx: 8192 }), or("big", { ctx: 262144 })] }),
  });
  assert.deepEqual(r.discovered, ["big"]);
});

test("an expired id is dropped even while still listed", async () => {
  // Vendors publish end-dates. Honouring one turns rot from something noticed
  // afterwards into something avoided in advance.
  const chain = [provider("v", ["ending"])];
  const now = () => Date.parse("2026-10-01T00:00:00Z");
  const [r] = await resolveChain(chain, {
    env: ENV,
    now,
    discover: false,
    fetchImpl: serve({ "v.test": [or("ending", { expires: "2026-09-30" })] }),
  });
  assert.deepEqual(r.dropped, ["ending"]);
  assert.deepEqual(r.models, []);
});

test("an id expiring LATER is kept, and flagged", async () => {
  const chain = [provider("v", ["ending"])];
  const now = () => Date.parse("2026-09-13T00:00:00Z");
  const [r] = await resolveChain(chain, {
    env: ENV,
    now,
    discover: false,
    fetchImpl: serve({ "v.test": [or("ending", { expires: "2026-09-30" })] }),
  });
  assert.deepEqual(r.models, ["ending"]);
  assert.deepEqual(r.expiring, [{ model: "ending", on: "2026-09-30" }]);
});

test("the discovered tail is capped", async () => {
  // Unbounded, one bad minute at a vendor becomes dozens of sequential retries
  // before the caller ever sees an error.
  const many = Array.from({ length: 30 }, (_, i) => or(`m${String(i).padStart(2, "0")}`));
  const chain = [provider("v", [])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    maxDiscovered: 4,
    fetchImpl: serve({ "v.test": many }),
  });
  assert.equal(r.discovered.length, 4);
});

test("discovery can be turned off entirely", async () => {
  const chain = [provider("v", ["a"])];
  const [r] = await resolveChain(chain, {
    env: ENV,
    discover: false,
    fetchImpl: serve({ "v.test": [or("a"), or("b")] }),
  });
  assert.deepEqual(r.models, ["a"]);
});

test("a vendor with nothing left keeps its row in the chain", async () => {
  // Dropping the row would make a vendor silently vanish — which is how a chain
  // quietly becomes a single point of failure with nobody noticing.
  const chain = [provider("dead", ["gone"]), provider("live", ["here"], "K")];
  const resolved = await resolveChain(chain, {
    env: ENV,
    discover: false,
    fetchImpl: serve({ "dead.test": [or("something-else")], "live.test": [or("here")] }),
  });
  assert.deepEqual(emptyProviders(resolved), ["dead"]);
  const applied = applyResolution(chain, resolved);
  assert.equal(applied.length, 2);
  assert.deepEqual(applied[0].models, []);
  assert.deepEqual(applied[1].models, ["here"]);
});

test("applyResolution leaves everything but the model list alone", async () => {
  const chain = [provider("v", ["a"])];
  const resolved = await resolveChain(chain, {
    env: ENV,
    discover: false,
    fetchImpl: serve({ "v.test": [or("a")] }),
  });
  const [p] = applyResolution(chain, resolved);
  assert.equal(p.baseUrl, chain[0].baseUrl);
  assert.equal(p.keyEnv, chain[0].keyEnv);
  assert.equal(p.dailyTokens, chain[0].dailyTokens);
});

test("the env override still wins, because that is how an operator routes around rot", async () => {
  const chain = [provider("v", ["declared"])];
  const [r] = await resolveChain(chain, {
    env: { ...ENV, T_V_MODELS: "override-a override-b" },
    discover: false,
    fetchImpl: serve({ "v.test": [or("override-a"), or("declared")] }),
  });
  assert.deepEqual(r.models, ["override-a"]);
  assert.deepEqual(r.dropped, ["override-b"]);
});

test("the report keeps could-not-look distinct from a pass", async () => {
  const chain = [provider("up", ["a"]), provider("blind", ["b"])];
  const resolved = await resolveChain(chain, {
    env: ENV,
    fetchImpl: serve({ "up.test": [or("a"), or("extra")], "blind.test": 500 }),
  });
  const text = resolutionReport(resolved);
  assert.match(text, /unreadable/);
  assert.match(text, /UNVERIFIED/);
  assert.match(text, /\+ extra/);
});
