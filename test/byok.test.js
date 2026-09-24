/**
 * A reader's key goes only to a host this package names, and only to that one.
 * The closed list is the security property; every test here pins a piece of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BYOK_VENDORS,
  BYOK_VENDOR_IDS,
  byokChain,
  byokKeyHint,
  byokLabel,
  byokVendor,
  isByokConfig,
} from "@bitbaum/ai-kit/byok";
import { openSecret, sealSecret } from "@bitbaum/ai-kit/seal";
import { LinkFailure, createLinkCooldown, completeStream } from "@bitbaum/ai-kit";

const good = { vendor: "anthropic", apiKey: "sk-ant-abcdefghijkl", model: "claude-opus-5" };

test("every vendor is https, unique, and OpenAI-shaped (no chat path in the base)", () => {
  const ids = new Set();
  for (const v of BYOK_VENDORS) {
    assert.ok(v.baseUrl.startsWith("https://"), v.id);
    assert.ok(!/chat\/completions/.test(v.baseUrl), v.id);
    assert.ok(v.keyUrl.startsWith("https://"), v.id);
    assert.ok(!ids.has(v.id), `duplicate ${v.id}`);
    ids.add(v.id);
  }
  assert.deepEqual([...ids], [...BYOK_VENDOR_IDS]);
});

test("a config naming a host, an unknown vendor or a smuggled header is refused", () => {
  assert.equal(isByokConfig(good), true);
  assert.equal(isByokConfig({ ...good, vendor: "https://evil.example" }), false);
  assert.equal(isByokConfig({ ...good, vendor: "ollama" }), false);
  assert.equal(isByokConfig({ ...good, apiKey: "sk-ant-abc\r\nX-Evil: 1" }), false);
  assert.equal(isByokConfig({ ...good, apiKey: "short" }), false);
  assert.equal(isByokConfig({ ...good, model: "" }), false);
  assert.equal(isByokConfig(null), false);
});

test("byokChain scopes the key to a one-entry env and the vendor's own host", () => {
  const { chain, env, extraHeaders } = byokChain(good);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].provider.baseUrl, byokVendor("anthropic").baseUrl);
  assert.equal(chain[0].model, "claude-opus-5");
  assert.deepEqual(Object.values(env), [good.apiKey]);
  assert.equal(extraHeaders, undefined);
  const routed = byokChain(
    { ...good, vendor: "openrouter", model: "x/y" },
    { url: "https://a.b", title: "A" },
  );
  assert.equal(routed.chain[0].provider.routed, true);
  assert.equal(routed.extraHeaders["X-Title"], "A");
});

test("the key reaches the vendor's host as a bearer token, streamed", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization ?? init.headers.authorization });
    const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const { chain, env } = byokChain({
    ...good,
    vendor: "google",
    model: "models/gemini-flash-latest",
  });
  let text = "";
  for await (const d of completeStream({
    chain,
    env,
    messages: [{ role: "user", content: "x" }],
    fetchImpl,
  })) {
    if (d.type === "text") text += d.text;
  }
  assert.equal(text, "hi");
  assert.equal(
    seen[0].url,
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
  assert.equal(seen[0].auth, `Bearer ${good.apiKey}`);
});

test("labels never carry the key", () => {
  assert.equal(byokLabel(good), "Anthropic · claude-opus-5");
  assert.equal(byokKeyHint("sk-ant-0123456789wxyz"), "…wxyz");
  assert.equal(byokKeyHint("short-key"), "…");
});

test("seal round-trips, is randomised, and refuses a wrong secret, context or tamper", () => {
  const secret = "a-very-long-test-secret-value";
  const a = sealSecret("sk-live-key", secret);
  const b = sealSecret("sk-live-key", secret);
  assert.notEqual(a, b);
  assert.ok(!a.includes("sk-live-key"));
  assert.equal(openSecret(a, secret), "sk-live-key");
  assert.throws(() => openSecret(a, "another-long-test-secret"));
  assert.throws(() => openSecret(a, secret, "other"));
  const [iv, tag, body] = a.split(":");
  const flipped = body.slice(0, -1) + (body.endsWith("0") ? "1" : "0");
  assert.throws(() => openSecret(`${iv}:${tag}:${flipped}`, secret));
  assert.throws(() => sealSecret("x", "short"));
});

test("cooldown skips a link until its refusal resets, and never empties the chain", () => {
  let t = Date.UTC(2026, 8, 24, 10, 0, 0);
  const cd = createLinkCooldown({ now: () => t });
  const p = { id: "p", baseUrl: "https://x", keyEnv: "K", models: ["a", "b"], dailyTokens: 1 };
  const a = { provider: p, model: "a" };
  const b = { provider: p, model: "b" };
  cd.record(a, new LinkFailure(a, "429", { status: 429, kind: "daily" }));
  cd.record(b, new LinkFailure(b, "429", { status: 429, kind: "capacity", retryAfter: 30 }));
  assert.deepEqual(cd.filter([a, b]), [a, b], "all cooled: try everything rather than nothing");
  t += 31_000;
  assert.deepEqual(cd.filter([a, b]), [b]);
  t = Date.UTC(2026, 8, 25, 0, 0, 1);
  assert.deepEqual(cd.filter([a, b]), [a, b]);
  // A size refusal and a non-429 say nothing about the link.
  cd.record(a, new LinkFailure(a, "429", { status: 429, kind: "size" }));
  cd.record(a, new LinkFailure(a, "500", { status: 500 }));
  cd.record(a, new Error("boom"));
  assert.equal(cd.cooling().length, 0);
});
