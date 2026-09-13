/**
 * The grounding harness in its new home, pinned against the incident that
 * built it: a contact reported as "Ilya Druzhnikov (UZH)" where UZH existed
 * nowhere in the operator's data — it is the substring inside dr-UZH-nikov,
 * surfaced by a keyword match and narrated as an affiliation.
 *
 * These are behavior pins, not a port of the apps' suites: the apps keep
 * their own policy tests (when to repair, when a repair must be refused).
 * What must hold HERE is that the check itself still catches the canonical
 * fabrication and still renders absence as an explicit negative — because
 * from this version on, this copy is the only definition of "grounded" the
 * fleet has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeFact,
  assignFactIds,
  renderFacts,
  verifyAnswer,
  NOT_RECORDED,
} from "@bitbaum/ai-kit/grounding";

const elena = () =>
  assignFactIds([
    makeFact({
      kind: "person",
      subject: "Elena Weber",
      source: "people",
      // Only DECLARED fields survive makeFact — affiliation and channels are
      // in person's declared set; an undeclared key would be dropped, which is
      // itself part of the design (nothing reaches the model unregistered).
      values: { name: "Elena Weber", affiliation: "SINGA Switzerland", channels: "+41774730093" },
    }),
  ]);

test("absence renders as an explicit negative, not as silence", () => {
  const rendered = renderFacts(elena());
  assert.ok(rendered.includes(NOT_RECORDED), "undeclared fields must render as <not recorded>");
  assert.ok(rendered.includes("SINGA Switzerland"));
});

test("the canonical fabrication is caught: a novel proper noun with no source", () => {
  const facts = elena();
  const { ok, violations } = verifyAnswer({
    answer: "Your contact is Ilya Druzhnikov at the University of Liechtenstein.",
    facts,
    userMessage: "who should I contact?",
  });
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === "novel-proper-noun"));
});

// ── A citation is its ID, not its bracket shape ─────────────────────────────
// Observed 2026-09-13: `openai/gpt-oss-120b` and `groq/compound-mini` both
// answered with the fullwidth CJK brackets, unprompted, from a prompt whose
// every example used [F1]. An ASCII-only match does not flag those as bad — it
// cannot see them, so an invented citation in that shape sails past the one
// rule written to catch invented proof.

test("an invented citation is caught in FULLWIDTH brackets too", () => {
  const { ok, violations } = verifyAnswer({
    answer: "Elena Weber is at SINGA Switzerland\u3010F9\u3011.",
    facts: elena(),
    userMessage: "who should I contact?",
  });
  assert.equal(ok, false, "F9 is not a record in this turn");
  const cite = violations.find((v) => v.kind === "unknown-citation");
  assert.ok(cite, JSON.stringify(violations));
  assert.equal(
    cite.text,
    "\u3010F9\u3011",
    "reported as the model wrote it, so the author can find it",
  );
});

test("a VALID citation in fullwidth brackets is not turned into a violation", () => {
  const { violations } = verifyAnswer({
    answer: "Elena Weber (SINGA Switzerland)\u3010F1\u3011.",
    facts: elena(),
    userMessage: "who should I contact?",
  });
  assert.equal(
    violations.filter((v) => v.kind === "unknown-citation").length,
    0,
    JSON.stringify(violations),
  );
});

test("the true answer passes clean — names and numbers attested by the records", () => {
  const facts = elena();
  const { ok, violations } = verifyAnswer({
    answer: "Elena Weber (SINGA Switzerland) — +41774730093.",
    facts,
    userMessage: "who should I contact?",
  });
  assert.equal(ok, true, JSON.stringify(violations));
});

test("what the user themselves said is never a fabrication", () => {
  const { ok } = verifyAnswer({
    answer: "Noted — Bahnhofstrasse 12 is saved as the meeting point.",
    facts: [],
    userMessage: "we meet at Bahnhofstrasse 12",
  });
  assert.equal(ok, true);
});

// ── Markdown tables ─────────────────────────────────────────────────────────
// A live answer laid its findings out as a table and was reported as
// fabricating. The header row `| Category | Item | Status | Notes |` produced
// the runs "Item" and "Item Status Notes Pending" — the last having run on into
// the FIRST CELL OF THE NEXT ROW, because a pipe is not a word character and so
// was not a boundary.
//
// That is the worst direction for this check to fail in. A warning that fires
// on correct answers teaches the operator to dismiss the warning, which costs
// more than the fabrication it exists to catch.

test("a grounded answer laid out as a table does NOT read as fabricating", () => {
  const facts = assignFactIds([
    makeFact({
      kind: "alert",
      subject: "printcraft: 4 consecutive failed runs",
      source: "alerts table",
      values: { title: "printcraft: 4 consecutive failed runs", severity: "urgent" },
    }),
  ]);
  const { ok, violations } = verifyAnswer({
    answer: [
      "**Things that need your attention right now**",
      "",
      "| Category | Item | Status | Notes |",
      "|----------|------|--------|-------|",
      "| **Open alerts** | printcraft: 4 consecutive failed runs | Urgent | Alert [F1] |",
    ].join("\n"),
    facts,
    userMessage: "what needs me right now",
  });
  assert.equal(ok, true, JSON.stringify(violations.map((v) => v.text)));
});

test("a run cannot span two table cells", () => {
  // The exact shape observed: the tail of one row joined to the head of the
  // next, inventing a composite that appears nowhere on screen as a phrase.
  const { violations } = verifyAnswer({
    answer: "| Status | Notes |\n|---|---|\n| Pending | none |",
    facts: [],
    userMessage: "status?",
  });
  assert.equal(
    violations.filter((v) => v.text.includes("Status Notes")).length,
    0,
    `a cell boundary is an utterance boundary: ${JSON.stringify(violations.map((v) => v.text))}`,
  );
});

test("but a fabrication INSIDE a cell is still caught, run and tokens both", () => {
  // The recall side of the trade. If this ever goes quiet, the boundary above
  // has stopped being a boundary and become a blindfold.
  const facts = assignFactIds([
    makeFact({
      kind: "person",
      subject: "Elena Weber",
      source: "people table",
      values: { name: "Elena Weber" },
    }),
  ]);
  const { ok, violations } = verifyAnswer({
    answer:
      "| Person | Role |\n|---|---|\n| Elena Weber | Program Manager at Impact Hub Zurich [F1] |",
    facts,
    userMessage: "who is Elena",
  });
  const flagged = violations.map((v) => v.text);
  assert.equal(ok, false);
  assert.ok(flagged.includes("Impact Hub Zurich"), `composite run: ${JSON.stringify(flagged)}`);
  assert.ok(flagged.includes("Zurich"), `individual tokens too: ${JSON.stringify(flagged)}`);
});
