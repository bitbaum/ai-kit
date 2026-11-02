import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAnswerPrefix } from "@bitbaum/ai-kit";

test("a narrated XML call never becomes visible prose, across every chunk boundary", () => {
  const text =
    "<tool_call> <function=search_records> <parameter=query> room </parameter> </function> </tool_call>";
  for (let boundary = 0; boundary < text.length; boundary++) {
    const first = classifyAnswerPrefix(text.slice(0, boundary));
    assert.notEqual(first, "answer", `protocol leaked at boundary ${boundary}`);
  }
  assert.equal(classifyAnswerPrefix(text), "protocol");
});

test("recognises the function form, plural wrapper and whitespace without executing anything", () => {
  for (const text of ["<function=search_records>", "<tool_calls>", " \n<TOOL_CALL >"])
    assert.equal(classifyAnswerPrefix(text), "protocol");
  for (const text of ["", " \n", "<", "<to", "<tool_call"])
    assert.equal(classifyAnswerPrefix(text), "pending");
});

test("ordinary answers, HTML and quoted code stay visible", () => {
  for (const text of [
    "Open your project’s room.",
    "<div>Hello</div>",
    "<tool_calling> is a name",
    "```xml\n<tool_call>\n```",
    "Tool: a hammer",
  ])
    assert.equal(classifyAnswerPrefix(text), "answer");
});
