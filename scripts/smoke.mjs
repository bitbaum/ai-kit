/**
 * Does the engine actually WORK, against real vendors, today?
 *
 * Every other check in this repo is hermetic: `test/` drives `complete()`
 * through an injected fetch, and `check-catalog.mjs` asks whether the pinned
 * ids still exist. Both can be green while the package cannot complete a single
 * real turn — a changed request shape, a header a vendor started rejecting, a
 * response envelope that moved. Nothing here has ever made a real generation.
 *
 * That gap matters more now than it did. This package is becoming the one
 * engine behind every app in the fleet, and a shared engine converts its own
 * bugs into a fleet-wide outage: the same defect, in every app, at once. The
 * hermetic tests say the LOGIC is right. This says the THING RUNS.
 *
 * ── WHY THIS IS NOT A PR GATE ────────────────────────────────────────────────
 * It calls other people's servers, so it fails for reasons that have nothing to
 * do with the diff: a vendor 500, a spent daily budget, a retired id. Wired into
 * PR CI it would redden an unrelated pull request and teach everyone to ignore
 * a red check — the failure mode where a live smoke arms a trap that springs on
 * whoever pushes next. So it runs on a SCHEDULE, where a failure means what it
 * says: the engine could not complete a turn today.
 *
 * Exit 1 only when the chain was walked and every link failed. No keys means
 * nothing was attempted, which is a different sentence, and it is the caller's
 * job (the workflow) to decide whether being unable to look is acceptable.
 *
 * Run: node scripts/smoke.mjs        (pnpm run smoke)
 */
import { complete, freeChain, usableChain, ChainExhaustedError } from "../dist/index.js";

const chain = usableChain(freeChain());

if (chain.length === 0) {
  console.log("NO KEYS — nothing was attempted. Set GROQ_API_KEY / OPENROUTER_API_KEY.");
  // Not a pass and not a failure: it is a non-answer. The workflow decides.
  process.exit(2);
}

console.log(`Walking ${chain.length} link(s).`);

// A question with exactly one right answer, short enough that no model needs a
// large budget, and phrased so a correct reply cannot be produced by a model
// that is echoing the prompt back — the failure that "200 with empty content"
// is the extreme version of.
const messages = [
  { role: "system", content: "Answer with a single word, no punctuation." },
  { role: "user", content: "What colour is a clear midday sky? Answer in one word." },
];

const started = Date.now();
try {
  const result = await complete({
    messages,
    // Generous for a one-word answer, and deliberately so: the default chain
    // leads with REASONING models, which spend this budget thinking before they
    // emit a single visible token. At 16 the thinking consumes all of it and the
    // vendor returns 200 with empty content — indistinguishable, from the
    // outside, from the dead-model case this script exists to detect. Verified
    // 2026-09-05: groq/openai/gpt-oss-20b answered empty at 16, fine at 256.
    maxTokens: 256,
    temperature: 0,
    onLinkFailure: (link, error) =>
      console.log(`  demoted ${link.provider.id}/${link.model} — ${error.message}`),
  });

  const ms = Date.now() - started;
  const answer = result.text.trim();
  console.log(`\nserved by : ${result.id}`);
  console.log(`answered  : ${JSON.stringify(answer)}  (${ms}ms)`);

  // The point is that a real model produced real words. Asserting the answer is
  // literally "blue" would make a vendor's phrasing ("Blue.") fail a working
  // engine, so the bar is: non-empty, and short enough to be an answer rather
  // than a refusal or an error page that arrived with a 200.
  if (answer.length === 0) {
    console.error(
      "::error::Empty answer survived the chain — the empty-content guard is not working.",
    );
    process.exit(1);
  }
  if (answer.length > 120) {
    console.error(
      `::error::Answer implausibly long for a one-word question (${answer.length} chars) — likely an error body returned as content.`,
    );
    process.exit(1);
  }

  console.log("\nThe engine completed a real turn.");
} catch (error) {
  if (error instanceof ChainExhaustedError) {
    console.error(`\n::error::Every link failed — the engine cannot complete a turn.`);
    for (const f of error.failures) console.error(`  ${f.message}`);
    process.exit(1);
  }
  console.error(
    `\n::error::Unexpected failure (not a chain exhaustion) — ${error?.stack ?? error}`,
  );
  process.exit(1);
}
