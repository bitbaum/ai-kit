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

import { makeFact, assignFactIds, renderFacts, verifyAnswer, NOT_RECORDED } from "ai-kit/grounding";

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
