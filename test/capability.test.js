/**
 * Tests for ai-kit/capability.
 *
 * The property most worth defending: a NEGATIVE is sticky. If an unrelated 400
 * gets written down as "this model has no tools", that model is crippled until
 * the record expires and nothing in the product explains why. So most of this
 * file is about what must NOT be recorded.
 *
 * The second property: "never asked" must survive as its own answer, in both
 * directions — optimistic on the wire, pessimistic in what we claim. A single
 * boolean cannot hold that, which is the whole reason this module exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyToolAttempt,
  saysToolsUnsupported,
  planToolAttempt,
  claimableVerdict,
  currentVerdict,
  isStale,
  makeRecord,
  scopeKey,
  shouldReplace,
} from "@bitbaum/ai-kit/capability";

// ── what a real response proves ─────────────────────────────────────────────

test("one tool_calls response proves capability outright", () => {
  const c = classifyToolAttempt({
    status: 200,
    parsed: { choices: [{ message: { tool_calls: [{ id: "1", function: { name: "x" } }] } }] },
  });
  assert.equal(c.verdict, "native");
  assert.equal(c.record, true);
});

test("finish_reason alone is enough, since some vendors report it that way", () => {
  const c = classifyToolAttempt({
    status: 200,
    parsed: { choices: [{ finish_reason: "tool_calls", message: {} }] },
  });
  assert.equal(c.verdict, "native");
  assert.equal(c.record, true);
});

test("a tool call found in prose is the text protocol, and it is a real capability", () => {
  const c = classifyToolAttempt({
    status: 200,
    parsed: { choices: [{ message: { content: '{"tool":"search"}' } }] },
    textProtocolFound: true,
  });
  assert.equal(c.verdict, "text");
  assert.equal(c.record, true);
});

test("answering without calling a tool proves NOTHING either way", () => {
  // The model may be incapable, or it may have correctly decided no tool was
  // needed — which is the right behaviour for most messages. Recording this
  // would mark almost every model `none` within a few turns of ordinary chat.
  const c = classifyToolAttempt({
    status: 200,
    parsed: { choices: [{ finish_reason: "stop", message: { content: "Hello." } }] },
  });
  assert.equal(c.verdict, "unobserved");
  assert.equal(c.record, false);
});

// ── the expensive direction ─────────────────────────────────────────────────

test("a 400 that NAMES tools is a real negative", () => {
  for (const body of [
    '{"error":{"message":"Tool use is not supported for this model"}}',
    '{"error":{"message":"model gpt-x does not support tools"}}',
    '{"error":{"message":"Unsupported parameter: \'tools\'"}}',
    '{"error":{"message":"function calling is not supported"}}',
  ]) {
    const c = classifyToolAttempt({ status: 400, bodyText: body });
    assert.equal(c.verdict, "none", body);
    assert.equal(c.record, true, body);
  }
});

test("a 400 about ANYTHING ELSE must never be recorded as incapable", () => {
  // This is the test the whole module exists for. Each of these is a real 400
  // that has nothing to do with tools, and recording any of them as `none`
  // would permanently downgrade a perfectly capable model.
  for (const body of [
    '{"error":{"message":"maximum context length is 8192 tokens, however you requested 9000"}}',
    '{"error":{"message":"Invalid value for temperature"}}',
    '{"error":{"message":"content filtered"}}',
    '{"error":{"message":"Your account is not active"}}',
    '{"error":{"message":"unsupported value: response_format"}}',
    '{"error":{"message":"bad request"}}',
  ]) {
    const c = classifyToolAttempt({ status: 400, bodyText: body });
    assert.equal(c.record, false, `must not learn from: ${body}`);
    assert.equal(c.verdict, "unobserved", body);
  }
});

test("rate limits, auth failures and outages teach nothing", () => {
  for (const status of [401, 403, 429, 500, 502, 503]) {
    const c = classifyToolAttempt({ status, bodyText: '{"error":{"message":"nope"}}' });
    assert.equal(c.record, false, `status ${status}`);
    assert.equal(c.verdict, "unobserved", `status ${status}`);
  }
});

test("a transport failure teaches nothing", () => {
  const c = classifyToolAttempt({ bodyText: "" });
  assert.equal(c.record, false);
  assert.equal(c.verdict, "unobserved");
});

test("the unsupported-tools matcher does not fire on ordinary refusals", () => {
  assert.equal(saysToolsUnsupported("maximum context length exceeded"), false);
  assert.equal(saysToolsUnsupported("unsupported parameter: response_format"), false);
  assert.equal(saysToolsUnsupported("this model is not supported on your plan"), false);
  assert.equal(saysToolsUnsupported(""), false);
  assert.equal(saysToolsUnsupported("tool calling is not supported"), true);
});

/**
 * A missed phrasing is not a cheap failure.
 *
 * The header used to say a false negative "costs one request". It does not.
 * The caller that sends tool definitions also DROPS its prose fallback, so a
 * refusal nobody recognises leaves the model unable to call a tool and no
 * longer told how to act without one — and since nothing is recorded, that
 * repeats on every single turn. The list has to cover how vendors actually
 * write the sentence, not just one grammatical form of it.
 */
test("recognises the sentence in the forms vendors actually write it", () => {
  const refusals = [
    // The gap that started this: plural subject, plural verb. Matched nothing.
    "tools are not supported by this model",
    "Tools are not supported for this model.",
    "functions are not supported",
    "tools are unsupported",
    "tool is not supported",
    // Already covered, and must stay covered.
    "tool calling is not supported",
    "This model does not support tool use",
    "doesn't support tools",
    "no support for tools",
    "function calling is not supported",
    "unsupported parameter: 'tools'",
    "unknown field: tools",
    "tools is not a valid parameter",
    // Plainly-worded incapacity.
    "this model cannot use tools",
    "the model can't call functions",
    "this model is unable to use tools",
    "no tool support on this endpoint",
  ];
  for (const body of refusals) {
    assert.equal(saysToolsUnsupported(body), true, `should match: ${body}`);
  }
});

test("widening the matcher did not make it fire on unrelated refusals", () => {
  // Each of these is a real 400/401/429 that says NOTHING about tools. A match
  // here would silently downgrade a working model, which is the worse failure
  // of the two because nobody can see it happen.
  const innocent = [
    "maximum context length exceeded",
    "unsupported parameter: response_format",
    "this model is not supported on your plan",
    "Rate limit reached for requests",
    "Invalid API key provided",
    "You exceeded your current quota",
    "The model `gpt-9` does not exist",
    "streaming is not supported for this model",
    "vision is not supported by this model",
    "json_schema is not a valid response_format",
    "your account is not allowed to use this model",
    "temperature is not supported with this model",
    "",
  ];
  for (const body of innocent) {
    assert.equal(saysToolsUnsupported(body), false, `should NOT match: ${body}`);
  }
});

// ── optimistic on the wire, pessimistic in the claim ────────────────────────

test("an unobserved model is ASKED, and the request doubles as the probe", () => {
  const plan = planToolAttempt({ observed: "unobserved" });
  assert.equal(plan.sendTools, true);
  assert.equal(plan.expectTextProtocol, true, "either answer must be accepted");
  assert.equal(plan.isLearning, true);
});

test("an unobserved model may NOT be claimed as capable", () => {
  // The same state, read the other way. A boolean cannot do this.
  assert.equal(claimableVerdict("unobserved"), "none");
  assert.equal(claimableVerdict("native"), "native");
  assert.equal(claimableVerdict("text"), "text");
});

test("a registry saying no lowers the effort but still listens for prose", () => {
  const plan = planToolAttempt({ observed: "unobserved", declared: "none" });
  assert.equal(plan.sendTools, false);
  assert.equal(plan.expectTextProtocol, true, "a declared no is a prior, not a fact");
});

test("an observed text-protocol model stops being sent definitions it ignores", () => {
  const plan = planToolAttempt({ observed: "text" });
  assert.equal(plan.sendTools, false);
  assert.equal(plan.expectTextProtocol, true);
  assert.equal(plan.isLearning, false);
});

test("an observed incapable model is not asked again until the record expires", () => {
  const plan = planToolAttempt({ observed: "none" });
  assert.equal(plan.sendTools, false);
  assert.equal(plan.expectTextProtocol, false);
});

// ── records expire, because models change under their own names ─────────────

test("a stale record decays to unobserved rather than standing forever", () => {
  const old = makeRecord({
    provider: "p",
    model: "m",
    scope: "s",
    capability: "tools",
    verdict: "native",
    via: "live",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(currentVerdict(old, new Date("2026-09-01T00:00:00Z")), "unobserved");
  assert.equal(currentVerdict(old, new Date("2026-01-02T00:00:00Z")), "native");
});

test("a negative expires sooner than a positive", () => {
  // A model that gained tools and is still marked `none` is invisibly
  // crippled; one that lost them says so loudly on the next call.
  const at = new Date("2026-01-01T00:00:00Z");
  const base = { provider: "p", model: "m", scope: "s", capability: "tools", via: "live" };
  const negative = makeRecord({ ...base, verdict: "none", now: at });
  const positive = makeRecord({ ...base, verdict: "native", now: at });
  const twoWeeksLater = new Date("2026-01-15T00:00:00Z");

  assert.equal(isStale(negative, twoWeeksLater), true);
  assert.equal(isStale(positive, twoWeeksLater), false);
});

test("no record at all is unobserved, not incapable", () => {
  assert.equal(currentVerdict(null), "unobserved");
  assert.equal(currentVerdict(undefined), "unobserved");
});

// ── credentials, and not storing them ───────────────────────────────────────

test("the scope identifies a credential without being one", () => {
  const a = scopeKey("sk-secret-value");
  const b = scopeKey("sk-different-value");
  assert.notEqual(a, b, "different keys must not share observations");
  assert.equal(a, scopeKey("sk-secret-value"), "stable for the same key");
  assert.ok(!a.includes("secret"), "the key must not survive into the handle");
  assert.equal(scopeKey(undefined), "anonymous");
});

// ── which observation wins ──────────────────────────────────────────────────

test("a real call overrules a registry claim", () => {
  const declared = makeRecord({
    provider: "p",
    model: "m",
    scope: "s",
    capability: "tools",
    verdict: "native",
    via: "declared",
    now: new Date("2026-09-01T00:00:00Z"),
  });
  const live = makeRecord({
    provider: "p",
    model: "m",
    scope: "s",
    capability: "tools",
    verdict: "none",
    via: "live",
    now: new Date("2026-08-01T00:00:00Z"), // older, and still wins
  });
  assert.equal(shouldReplace(declared, live), true);
  assert.equal(shouldReplace(live, declared), false);
});

test("a newer observation replaces an older one of the same strength, in both directions", () => {
  const base = { provider: "p", model: "m", scope: "s", capability: "tools", via: "live" };
  const older = makeRecord({ ...base, verdict: "native", now: new Date("2026-08-01T00:00:00Z") });
  const newer = makeRecord({ ...base, verdict: "none", now: new Date("2026-09-01T00:00:00Z") });
  // A model really can lose a capability; refusing to believe that is how a
  // chain keeps calling something that no longer works.
  assert.equal(shouldReplace(older, newer), true);
  assert.equal(shouldReplace(newer, older), false);
});

test("anything replaces nothing", () => {
  const rec = makeRecord({
    provider: "p",
    model: "m",
    scope: "s",
    capability: "tools",
    verdict: "native",
    via: "declared",
  });
  assert.equal(shouldReplace(null, rec), true);
});
