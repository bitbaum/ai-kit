/**
 * A picture must never be sent to a model that cannot read one, and a model
 * nobody has classified must never be refused one. Both directions are pinned
 * here, because getting either wrong is silent.
 *
 * The first direction fails by producing a fluent answer about an image the
 * model never saw. The second fails by refusing a capability to the user who
 * brought the best model — which is the inversion OrangeCat's ADR-0008 named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  freeChain,
  usableChain,
  modelSeesImages,
  linkSeesImages,
  seeingLinks,
  visionProviders,
  messagesCarryImages,
  NoVisionLinkError,
  complete,
} from "@bitbaum/ai-kit";

const CHAIN = freeChain("TEST");
const groq = CHAIN.find((p) => p.id === "groq");
const google = CHAIN.find((p) => p.id === "google");
const openrouter = CHAIN.find((p) => p.id === "openrouter");

const PICTURE = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const withPicture = [{ role: "user", content: [{ type: "text", text: "what is this" }, PICTURE] }];
const textOnly = [{ role: "user", content: "what is this" }];

test("a declared-blind model answers 'no', not 'unknown'", () => {
  // Groq leads the default chain with four text models. If this ever reads
  // "unknown", every screenshot in the fleet goes to a model that cannot read
  // it FIRST, which is the bug this module was written for.
  assert.equal(modelSeesImages(groq, "openai/gpt-oss-120b"), "no");
  assert.equal(groq.visionModels.length, 0, "an empty list is a claim; absent is not");
});

test("a model in visionModels answers 'yes'", () => {
  assert.equal(modelSeesImages(openrouter, "google/gemma-4-26b-a4b-it:free"), "yes");
  assert.equal(modelSeesImages(google, "models/gemini-flash-latest"), "yes");
});

test("a model the provider never declared is UNKNOWN, never 'no'", () => {
  // The env-override case. `TEST_GROQ_MODELS` exists to route around rot, and
  // a list written months ago cannot have an opinion about the id someone
  // routes to. Reading that silence as a denial would make the escape hatch
  // silently disable vision.
  assert.equal(modelSeesImages(groq, "some-vendor/model-released-today"), "unknown");
  assert.equal(modelSeesImages(openrouter, "meta/llama-5-vision:free"), "unknown");
});

test("a provider that has said NOTHING leaves every model unknown", () => {
  // A user's own key. We built none of this chain and have no evidence about
  // any of it — so a picture is TRIED, not refused.
  const byok = {
    id: "theirs",
    baseUrl: "https://example.test/v1",
    keyEnv: "THEIR_KEY",
    models: ["their/model"],
    dailyTokens: 0,
  };
  assert.equal(modelSeesImages(byok, "their/model"), "unknown");
  assert.deepEqual(seeingLinks([{ provider: byok, model: "their/model" }]).length, 1);
});

test("seeingLinks drops the blind and keeps the unclassified, in order", () => {
  const links = usableChain(CHAIN, {
    GROQ_API_KEY: "k",
    GEMINI_API_KEY: "k",
    OPENROUTER_API_KEY: "k",
  });
  const sighted = seeingLinks(links);

  assert.ok(links.length > sighted.length, "the blind Groq links must be dropped");
  assert.ok(
    sighted.every((l) => linkSeesImages(l) !== "no"),
    "no declared-blind link may survive the filter",
  );
  assert.ok(
    !sighted.some((l) => l.provider.id === "groq"),
    "Groq serves no vision model on this account — see src/chain.ts",
  );

  // Order is the meter-draining order and must not be re-sorted by capability.
  const order = sighted.map((l) => `${l.provider.id}/${l.model}`);
  assert.deepEqual(
    order,
    links.filter((l) => linkSeesImages(l) !== "no").map((l) => `${l.provider.id}/${l.model}`),
  );
});

test("visionProviders is stricter than seeingLinks — it includes only proven sight", () => {
  const providers = visionProviders(CHAIN, { GEMINI_API_KEY: "k" });
  for (const provider of providers) {
    for (const model of provider.models) {
      assert.equal(
        modelSeesImages(provider, model),
        "yes",
        `${provider.id}/${model} is not declared sighted and must not be in a vision chain`,
      );
    }
  }
  assert.ok(
    !providers.some((p) => p.id === "groq"),
    "a provider with no sighted model is dropped, not kept empty",
  );
});

test("visionProviders honours a modelsEnv override without trusting it", () => {
  // The operator named a model we have no evidence about. It must not be
  // promoted into a chain that PROMISES vision just because they named it —
  // so Google drops out entirely rather than carrying an unprobed id.
  const narrowed = visionProviders(CHAIN, {
    TEST_GOOGLE_MODELS: "models/something-nobody-probed",
  });
  assert.ok(
    !narrowed.some((p) => p.id === "google"),
    "an override of unprobed ids must not be promoted into a vision chain",
  );
  // And the vendors it said nothing about are untouched.
  assert.ok(narrowed.some((p) => p.id === "openrouter"));
});

test("visionProviders leaves KEYS to usableChain, as every other chain builder does", () => {
  // It narrows models, not deployments. `usableChain(visionProviders(...))` is
  // the composition — folding key-checking in here would give the package two
  // places that decide whether a vendor is reachable.
  const providers = visionProviders(CHAIN, {});
  const withKey = usableChain(providers, { OPENROUTER_API_KEY: "k" });
  const without = usableChain(providers, {});
  assert.ok(withKey.length > 0);
  assert.equal(without.length, 0);
});

test("messagesCarryImages sees a picture, and is false for ordinary text", () => {
  assert.equal(messagesCarryImages(withPicture), true);
  assert.equal(messagesCarryImages(textOnly), false);
  assert.equal(messagesCarryImages([{ role: "user", content: [] }]), false);
});

test("complete() refuses a picture up front when the whole chain is blind", async () => {
  // The important half: it must NOT walk four Groq links and report "every
  // vendor failed". That error sends someone debugging an outage that is not
  // happening, while the real answer — no key for a vendor that can see — is
  // knowable before any request leaves the process.
  let called = false;
  await assert.rejects(
    () =>
      complete({
        messages: withPicture,
        env: { GROQ_API_KEY: "k" },
        providers: CHAIN,
        fetchImpl: async () => {
          called = true;
          throw new Error("no request should have been made");
        },
      }),
    (error) => {
      assert.ok(error instanceof NoVisionLinkError, `got ${error.name}: ${error.message}`);
      assert.ok(error.blind.length > 0, "the error must name what it skipped");
      assert.match(error.message, /skipped:/);
      return true;
    },
  );
  assert.equal(called, false, "not one token may be spent on a chain that cannot see");
});

test("a text turn on the same blind chain is untouched", async () => {
  // The filter must be inert for the overwhelming majority of calls. If this
  // fails, vision routing has broken every text caller in the fleet.
  let asked = 0;
  const result = await complete({
    messages: textOnly,
    env: { GROQ_API_KEY: "k" },
    providers: CHAIN,
    fetchImpl: async () => {
      asked++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.text, "hello");
  assert.equal(asked, 1, "the first Groq link must still be tried for text");
});

test("a picture reaches the sighted link and skips the blind ones", async () => {
  const tried = [];
  const result = await complete({
    messages: withPicture,
    env: { GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k" },
    providers: CHAIN,
    fetchImpl: async (url, init) => {
      tried.push(JSON.parse(init.body).model);
      return new Response(JSON.stringify({ choices: [{ message: { content: "red" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.text, "red");
  assert.deepEqual(tried, ["google/gemma-4-26b-a4b-it:free"], `tried: ${tried.join(", ")}`);
});
