/**
 * The line protocol, and the fabrication path a native-only client leaves open.
 *
 * Every shape below is one a small model actually emitted when asked to call a
 * tool. None is invented: the markdown bolding, the fenced ARGS, the copied
 * parentheses and the missing ARGS line are all things that happen, and each one
 * rejected is a turn failed over formatting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseTextToolCalls,
  stripToolCallLines,
  safeJsonObject,
  toolNamesFrom,
  TEXT_TOOL_PROTOCOL_HINT,
  complete,
} from "@bitbaum/ai-kit";

const NAMES = ["search_people", "list_projects", "propose_action"];

// ── The shapes models actually emit ─────────────────────────────────────────
test("the documented shape parses", () => {
  const [call] = parseTextToolCalls('TOOL: search_people\nARGS: {"query": "Elena"}', NAMES);
  assert.equal(call.name, "search_people");
  assert.deepEqual(JSON.parse(call.args), { query: "Elena" });
});

test("markdown bolding, list bullets and = instead of : all parse", () => {
  assert.equal(
    parseTextToolCalls('**TOOL:** search_people\n**ARGS:** {"query": "x"}', NAMES).length,
    1,
  );
  assert.equal(
    parseTextToolCalls('- TOOL: search_people\n- ARGS: {"query": "x"}', NAMES).length,
    1,
  );
  assert.equal(parseTextToolCalls('TOOL = search_people\nARGS = {"query": "x"}', NAMES).length, 1);
});

test("a name copied with its parentheses still resolves", () => {
  const [call] = parseTextToolCalls('TOOL: search_people(query)\nARGS: {"query": "Ilya"}', NAMES);
  assert.equal(call.name, "search_people");
  assert.deepEqual(JSON.parse(call.args), { query: "Ilya" });
});

test("a no-argument tool needs no ARGS line", () => {
  const [call] = parseTextToolCalls("TOOL: list_projects", NAMES);
  assert.equal(call.name, "list_projects");
  assert.equal(call.args, "{}");
});

test("a fenced ARGS block parses — the brace is on the NEXT line", () => {
  const [call] = parseTextToolCalls(
    'TOOL: search_people\nARGS: ```json\n{"query": "Elena"}\n```',
    NAMES,
  );
  assert.deepEqual(JSON.parse(call.args), { query: "Elena" });
});

test("a pretty-printed multi-line object parses", () => {
  const [call] = parseTextToolCalls(
    'TOOL: propose_action\nARGS: {\n  "type": "send_message",\n  "title": "Hello"\n}',
    NAMES,
  );
  assert.deepEqual(JSON.parse(call.args), { type: "send_message", title: "Hello" });
});

test("two calls in one reply both parse", () => {
  const calls = parseTextToolCalls(
    'TOOL: list_projects\nTOOL: search_people\nARGS: {"query": "Ada"}',
    NAMES,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args, "{}", "a call followed by another TOOL line has no args");
  assert.deepEqual(JSON.parse(calls[1].args), { query: "Ada" });
});

// ── Refusing to invent ──────────────────────────────────────────────────────
test("a tool the model was NOT offered is ignored", () => {
  // Without the closed-set check, prose containing "TOOL: rm_rf" manufactures a
  // call to something that does not exist, and the executor reports a failure
  // the model never asked for.
  assert.deepEqual(parseTextToolCalls("TOOL: drop_database\nARGS: {}", NAMES), []);
});

test("no offered tools means no parsing at all", () => {
  assert.deepEqual(parseTextToolCalls('TOOL: search_people\nARGS: {"query": "x"}', []), []);
});

// ── The JSON walker ─────────────────────────────────────────────────────────
test("a brace inside a quoted value does not truncate the object", () => {
  // Naive brace counting closes at the } inside the string and yields invalid
  // JSON, so the arguments vanish and the tool runs on nothing.
  const out = safeJsonObject('{"q": "a } b", "n": 1}');
  assert.deepEqual(out, { q: "a } b", n: 1 });
});

test("an escaped quote does not confuse the string tracker", () => {
  assert.deepEqual(safeJsonObject('{"q": "say \\"hi\\" }"}'), { q: 'say "hi" }' });
});

test("trailing prose after the object is tolerated", () => {
  assert.deepEqual(safeJsonObject('{"query": "Elena"} — then I will summarise'), {
    query: "Elena",
  });
});

test("unparseable is NULL, and empty-object is {} — they must stay distinct", () => {
  // Returning {} for "nothing parseable" satisfies a caller's ?? {} fallback and
  // silently discards arguments the model put on the next line.
  assert.equal(safeJsonObject("not json at all"), null);
  assert.equal(safeJsonObject(""), null);
  assert.deepEqual(safeJsonObject("{}"), {});
});

// ── Stripping ───────────────────────────────────────────────────────────────
test("protocol lines are removed but the model's real prose survives", () => {
  const stripped = stripToolCallLines(
    'Let me look her up.\nTOOL: search_people\nARGS: {"query": "Elena"}',
  );
  assert.equal(stripped, "Let me look her up.");
});

// ── Deriving the closed set ─────────────────────────────────────────────────
test("tool names come from the tools array the caller already passed", () => {
  // Two lists that must agree are one list that cannot disagree. A separate
  // name list fails silently: a missing name makes the parser ignore a real call.
  const tools = [
    { type: "function", function: { name: "search_people", parameters: {} } },
    { type: "function", function: { name: "list_projects" } },
    { type: "function" },
    null,
  ];
  assert.deepEqual(toolNamesFrom(tools), ["search_people", "list_projects"]);
  assert.deepEqual(toolNamesFrom(undefined), []);
});

test("the prompt hint names the same two keys the parser reads", () => {
  // A prompt and its parser are one contract; keeping them apart is how they drift.
  assert.match(TEXT_TOOL_PROTOCOL_HINT, /^TOOL: /m);
  assert.match(TEXT_TOOL_PROTOCOL_HINT, /^ARGS: /m);
  assert.equal(parseTextToolCalls("TOOL: list_projects", NAMES).length, 1);
});

// ── The whole point: complete() no longer hands back a narrated call ────────
const CHAIN = [
  {
    provider: {
      id: "openrouter",
      baseUrl: "https://openrouter.invalid/v1",
      keyEnv: "OPENROUTER_API_KEY",
      models: ["gemma"],
      dailyTokens: 1000,
    },
    model: "gemma",
  },
];
const ENV = { OPENROUTER_API_KEY: "k" };
const TOOLS = [{ type: "function", function: { name: "search_people", parameters: {} } }];

function replyWith(content, toolCalls) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
      }),
      { status: 200 },
    );
}

test("a text-only model's narrated call becomes a REAL tool call", async () => {
  // This is the fabrication path. Before, `text` came back as
  // "TOOL: search_people..." with toolCalls empty, and every layer downstream
  // treated a lookup that never happened as a finished answer.
  const result = await complete({
    chain: CHAIN,
    env: ENV,
    tools: TOOLS,
    messages: [{ role: "user", content: "who is Elena?" }],
    fetchImpl: replyWith('TOOL: search_people\nARGS: {"query": "Elena"}'),
  });

  assert.equal(result.toolCalls.length, 1, "the narration is a call, not an answer");
  assert.equal(result.toolCalls[0].name, "search_people");
  assert.equal(result.text, "", "and the protocol lines never reach the user as prose");
});

test("a reply that is ONLY a narrated call is a valid turn, not an empty-200 outage", async () => {
  // complete() treats an empty 200 as a link failure. After stripping, this
  // reply IS empty — so the ordering has to put tool calls first or a working
  // model gets demoted off the chain.
  const result = await complete({
    chain: CHAIN,
    env: ENV,
    tools: TOOLS,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: replyWith("TOOL: search_people\nARGS: {}"),
  });
  assert.equal(result.toolCalls.length, 1);
});

test("a native call and a prose echo of it run the tool ONCE", async () => {
  const result = await complete({
    chain: CHAIN,
    env: ENV,
    tools: TOOLS,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: replyWith('TOOL: search_people\nARGS: {"query":"Elena"}', [
      { id: "n1", function: { name: "search_people", arguments: '{"query":"Elena"}' } },
    ]),
  });
  assert.equal(result.toolCalls.length, 1, "the duplicate is dropped");
  assert.equal(result.toolCalls[0].id, "n1", "and the native one wins");
});

test("opting out leaves the narration exactly where it was", async () => {
  // For a caller that parses the text protocol itself and would otherwise
  // execute every call twice.
  const result = await complete({
    chain: CHAIN,
    env: ENV,
    tools: TOOLS,
    toolProtocol: "native",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: replyWith('TOOL: search_people\nARGS: {"query": "Elena"}'),
  });
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /^TOOL: search_people/);
});

test("with NO tools offered, prose that looks like the protocol is left alone", async () => {
  // Inert for every caller that does not use tools — which today is all of them.
  const result = await complete({
    chain: CHAIN,
    env: ENV,
    messages: [{ role: "user", content: "explain the format" }],
    fetchImpl: replyWith("You write TOOL: name on its own line."),
  });
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /TOOL: name/, "documentation about the protocol is not a call");
});
