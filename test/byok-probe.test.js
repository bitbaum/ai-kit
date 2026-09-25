/**
 * "Does this key work, and what can it use?" Every vendor behaviour pinned
 * here was observed against the live endpoint on 2026-09-25; the fetch is
 * faked so the suite is deterministic and never spends anyone's quota.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { probeByokKey, rankByokModels, suggestByokModel } from "@bitbaum/ai-kit/byok-probe";

const KEY = "sk-test-not-a-real-key-1234";

/** A fetch that answers per URL and records what it was asked. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
    const route = Object.entries(routes).find(([suffix]) => String(url).endsWith(suffix));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    const [status, body] = route[1];
    if (status === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const list = (...ids) => ({ data: ids.map((id, i) => ({ id, created: 1_700_000_000 + i })) });

test("OpenRouter's key is checked at /key — its public /models accepts a fake key", async () => {
  const { impl, calls } = fakeFetch({
    "/key": [401, { error: { message: "User not found.", code: 401 } }],
    "/models": [200, list("anthropic/claude-opus-5.5")], // public: 200 to anyone
  });
  const out = await probeByokKey("openrouter", KEY, { fetchImpl: impl });
  assert.equal(out.ok, false, "a fake key must not pass because /models is public");
  assert.equal(out.status, 401);
  assert.match(
    out.message,
    /OpenRouter didn't accept this key\. OpenRouter says: "User not found\."/,
  );
  assert.deepEqual(out.models, []);
  assert.ok(
    calls[0].url.endsWith("/key"),
    "the key is checked first, where it is actually checked",
  );
});

test("OpenRouter with a working key lists its models, best first", async () => {
  const { impl } = fakeFetch({
    "/key": [200, { data: { label: "k" } }],
    "/models": [
      200,
      list(
        "anthropic/claude-haiku-4.5",
        "anthropic/claude-opus-5.5",
        "anthropic/claude-opus-5.5:batch",
      ),
    ],
  });
  const out = await probeByokKey("openrouter", KEY, { fetchImpl: impl });
  assert.equal(out.ok, true);
  assert.equal(out.suggested, "anthropic/claude-opus-5.5");
  assert.ok(
    !out.models.includes("anthropic/claude-opus-5.5:batch"),
    "batch variants are not chat defaults",
  );
});

test("Anthropic is asked with x-api-key and its version header, never Bearer", async () => {
  const { impl, calls } = fakeFetch({
    "/v1/models": [
      200,
      {
        data: [
          { id: "claude-sonnet-5", created_at: "2026-05-01T00:00:00Z" },
          { id: "claude-opus-5.5", created_at: "2026-09-01T00:00:00Z" },
        ],
      },
    ],
  });
  const out = await probeByokKey("anthropic", KEY, { fetchImpl: impl });
  assert.equal(out.ok, true);
  assert.equal(out.suggested, "claude-opus-5.5");
  const h = calls[0].headers;
  assert.equal(h["x-api-key"], KEY);
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(h.Authorization, undefined);
});

test("a 400 rejection (Google, xAI) is a failed key, in the vendor's own words", async () => {
  const { impl } = fakeFetch({
    "/models": [
      400,
      { error: { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" } },
    ],
  });
  const out = await probeByokKey("google", KEY, { fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.match(
    out.message,
    /Google Gemini didn't accept this key\. Google Gemini says: "Please pass a valid API key"/,
  );
});

test("an unreachable vendor is 'could not check', never 'your key is wrong'", async () => {
  const { impl } = fakeFetch({ "/models": ["network"] });
  const out = await probeByokKey("openai", KEY, { fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.equal(out.status, null);
  assert.match(out.message, /Couldn't reach OpenAI/);
  assert.doesNotMatch(out.message, /didn't accept/);
});

test("rate-limited is reported as possibly valid", async () => {
  const { impl } = fakeFetch({ "/models": [429, { error: { message: "slow down" } }] });
  const out = await probeByokKey("groq", KEY, { fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.match(out.message, /may still be valid/);
});

test("the key never appears in what the reader is shown", async () => {
  const { impl } = fakeFetch({
    "/models": [401, { error: { message: `Incorrect API key provided: ${KEY}` } }],
  });
  const out = await probeByokKey("openai", KEY, { fetchImpl: impl });
  // Most vendors mask the key they echo; one that doesn't must not get it shown.
  assert.ok(!out.message.includes(KEY), `the key leaked into: ${out.message}`);
  assert.match(out.message, /…1234/, "masked to its last four, like everywhere else");
});

test("Together's bare-array list is read", async () => {
  const { impl } = fakeFetch({
    "/models": [200, [{ id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", created: 1 }]],
  });
  const out = await probeByokKey("together", KEY, { fetchImpl: impl });
  assert.equal(out.ok, true);
  assert.equal(out.models.length, 1);
});

test("unknown vendor and malformed keys are refused without a network call", async () => {
  const { impl, calls } = fakeFetch({});
  assert.equal((await probeByokKey("ollama", KEY, { fetchImpl: impl })).ok, false);
  assert.equal(
    (await probeByokKey("openai", "sk-abc\r\nX-Evil: 1", { fetchImpl: impl })).ok,
    false,
  );
  assert.equal(calls.length, 0);
});

// ── ranking: the newest model in the strongest tier, naming none ───────────
const rec = (id, created = null, outputModalities = null) => ({
  id,
  created,
  outputModalities,
  costsNothing: null,
  tools: null,
  contextLength: null,
  expiresOn: null,
});

test("top tier beats newer defaults; newest wins inside a tier", () => {
  const ranked = rankByokModels([
    rec("gpt-5.6-luna", 30),
    rec("gpt-5.6-luna-pro", 31),
    rec("gpt-5.6-terra-pro", 29),
    rec("gpt-5.6-mini", 40),
  ]);
  assert.deepEqual(ranked, [
    "gpt-5.6-luna-pro",
    "gpt-5.6-terra-pro",
    "gpt-5.6-luna",
    "gpt-5.6-mini",
  ]);
});

test("small parameter counts rank below; large ones do not", () => {
  const ranked = rankByokModels([rec("openai/gpt-oss-20b", 2), rec("openai/gpt-oss-120b", 1)]);
  assert.deepEqual(ranked, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
});

test("non-chat models are never suggested", () => {
  const out = suggestByokModel([
    rec("text-embedding-3-large", 99),
    rec("whisper-1", 98),
    rec("tts-1-hd", 97),
    rec("dall-e-3", 96),
    rec("gpt-5.1", 1),
  ]);
  assert.equal(out, "gpt-5.1");
});

test("a model the vendor says outputs no text is excluded; unknown is kept", () => {
  const ranked = rankByokModels([rec("veo-3", 9, ["video"]), rec("gemini-3.8-flash", 5, null)]);
  assert.deepEqual(ranked, ["gemini-3.8-flash"]);
});

test("an empty list suggests nothing", () => {
  assert.equal(suggestByokModel([]), null);
});

// ── cases taken from the live catalogues on 2026-09-25 ─────────────────────

test("Google (no dates): its -latest alias, then the higher version; music and tool variants excluded", () => {
  const ranked = rankByokModels([
    rec("models/gemini-2.5-pro"),
    rec("models/gemini-pro-latest"),
    rec("models/gemini-3.1-pro-preview"),
    rec("models/gemini-3.1-pro-preview-customtools"),
    rec("models/lyria-3-pro-preview"),
    rec("models/gemini-flash-latest"),
  ]);
  assert.equal(ranked[0], "models/gemini-pro-latest");
  assert.ok(
    ranked.indexOf("models/gemini-3.1-pro-preview") < ranked.indexOf("models/gemini-2.5-pro"),
    "3.1 outranks 2.5 when the vendor gives no dates",
  );
  assert.ok(!ranked.includes("models/lyria-3-pro-preview"), "a music model is not a chat default");
  assert.ok(!ranked.includes("models/gemini-3.1-pro-preview-customtools"));
});

test("a router suggests a frontier lab's flagship, not whoever shipped a 'max' last", () => {
  const out = suggestByokModel(
    [
      rec("qwen/qwen3.8-max-prime", 50),
      rec("xiaomi/mimo-v2.6-pro-ultraspeed", 49),
      rec("openai/gpt-6-luna-pro", 48),
      rec("anthropic/claude-opus-5.5", 47),
      rec("anthropic/claude-sonnet-5", 46),
    ],
    { preferNamespaces: ["anthropic/", "openai/", "google/", "x-ai/"] },
  );
  assert.equal(out, "anthropic/claude-opus-5.5");
});

test("a speed-tuned variant never outranks its full model", () => {
  const ranked = rankByokModels([rec("lab/model-pro-ultraspeed", 9), rec("lab/model-pro", 1)]);
  assert.deepEqual(ranked, ["lab/model-pro", "lab/model-pro-ultraspeed"]);
});

test("a parameter count is not a version", () => {
  const ranked = rankByokModels([rec("lab/chat-120b"), rec("lab/chat-2.0")]);
  // 120b is a size, not version 120; neither has a date, so 2.0 leads.
  assert.equal(ranked[0], "lab/chat-2.0");
});
