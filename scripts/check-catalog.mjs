/**
 * Are this package's DEFAULT pins still real?
 *
 * `freeChain()` ships a list of model ids, and vendors retire ids without
 * notice. On 2026-08-25 four of the nine defaults were already gone — both Groq
 * models, so the chain led with a vendor that could never answer, plus the
 * preferred OpenRouter fallback. Every consumer inherited that.
 *
 * Zero tokens: one GET /models per provider. Cheap enough to run on a schedule,
 * which is the only kind of check that catches rot without someone remembering.
 *
 * Run: node scripts/check-catalog.mjs        (npm run check:catalog)
 * Needs GROQ_API_KEY / OPENROUTER_API_KEY for the providers you want checked;
 * a provider with no key is reported UNCHECKED, which is not a pass.
 *
 * Exit 1 only on CONFIRMED rot, so a keyless or offline run does not fail a
 * pipeline for something it could not see.
 */
import { freeChain, checkCatalog, catalogReport, hasRot, deadProviders } from "../dist/index.js";

const verdicts = await checkCatalog(freeChain());
console.log(catalogReport(verdicts));
console.log("");

const dead = deadProviders(verdicts);
if (dead.length) {
  console.error(
    `A whole vendor is gone (${dead.join(", ")}) — the chain is back to a single point of failure.`,
  );
}
if (hasRot(verdicts)) {
  console.error(
    "Retired model ids are still pinned. Re-probe replacements and update freeChain().",
  );
  process.exit(1);
}
const unchecked = verdicts.reduce((n, v) => n + v.unchecked.length, 0);
if (unchecked) {
  console.log(`No rot found among the ids that could be checked; ${unchecked} were not checkable.`);
} else {
  console.log("Every default pin still exists at its vendor.");
}
