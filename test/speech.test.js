/**
 * The fleet's dictation chain and its silence guard, defined once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { looksLikeSilence, speechChain, speechConfigured } from "@bitbaum/ai-kit";

test("the speech chain is Whisper on Groq, turbo first, and claims no token pool", () => {
  const chain = speechChain();
  assert.deepEqual(
    chain.map((l) => l.model),
    ["whisper-large-v3-turbo", "whisper-large-v3"],
  );
  assert.ok(chain.every((l) => l.provider.dailyTokens === 0));
});

test("configured only with the speech key", () => {
  assert.equal(speechConfigured({}), false);
  assert.equal(speechConfigured({ GROQ_API_KEY: " " }), false);
  assert.equal(speechConfigured({ GROQ_API_KEY: "k" }), true);
});

test("Whisper's silence artefacts are recognised; real speech passes", () => {
  for (const s of ["Untertitelung des ZDF, 2020", "Amen.", "Thank you.", "", "  "])
    assert.equal(looksLikeSilence(s), true, s);
  for (const s of [
    "Vielen Dank für Ihre Hilfe, können Sie mir sagen",
    "What is the gallium price?",
  ])
    assert.equal(looksLikeSilence(s), false, s);
});
