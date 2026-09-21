/**
 * Can the models this package CLAIMS can see, actually see?
 *
 * `freeChain()` now carries `visionModels` per provider, and a claim in a list
 * is worth exactly as much as the last time somebody checked it. This is the
 * check. It sends a real image — a solid red square, inline, no network
 * fetch — and asks what colour it is.
 *
 * ── Why a trivial image and a trivial question ──────────────────────────────
 *
 * Because the failure this catches is total, not subtle. A model that cannot
 * read pictures does not return a slightly worse answer: it answers the text
 * and ignores the image entirely, fluently, with no marker that anything was
 * dropped. "What colour is this?" has exactly one right answer and cannot be
 * guessed from the prompt, so a blind model's confident paragraph fails
 * visibly. Judging PROSE QUALITY over a screenshot would need a human; judging
 * "did the pixels reach the model" needs one word.
 *
 * ── The third outcome ────────────────────────────────────────────────────────
 *
 * loki's own probe of this exact question found a model that answers HTTP 200
 * with EMPTY content (`nvidia/nemotron-nano-12b-v2-vl`, 2026-08-13), which a
 * naive client reports as a successful analysis of a picture it never read. So
 * an empty answer is a FAILURE here, never a pass, and it is named as its own
 * outcome rather than folded into "wrong".
 *
 * Run: node scripts/probe-vision.mjs          (pnpm run check:vision)
 * Needs a key per provider you want probed; a provider with no key is
 * UNCHECKED, which is not a pass.
 *
 * Costs a handful of tokens and one image tile per model — cheap, but not
 * free, so this is NOT on the daily schedule that `check-catalog.mjs` runs on.
 * Run it when `visionModels` changes, and when a vision answer looks wrong.
 *
 * Exit 1 only on a CONFIRMED false claim: a model listed in `visionModels`
 * that demonstrably did not read the image. A network failure, a 429 or a
 * missing key exits 0 — a check that cannot see is not a check that failed,
 * and a pipeline taught to ignore this one is worse than not having it.
 */
import { freeChain, providerModels, modelSeesImages } from "../dist/index.js";

/**
 * An 8×8 solid red PNG, base64, written out rather than generated.
 *
 * Inline so the probe needs no network beyond the vendor itself: a fixture
 * fetched from a URL turns "the model cannot see" and "the fixture host is
 * down" into the same red line.
 */
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHklEQVQoz2P8z8Dwn4GKgIlqJo0aOGrgqIGjBg4WAwFHVQEO2p2+CAAAAABJRU5ErkJggg==";

const QUESTION = "What colour is this image? Answer with one word: the colour name, nothing else.";

const TIMEOUT_MS = 45_000;

/** Did the answer name the colour in the picture? */
function readsRed(text) {
  return /\bred\b/i.test(text);
}

async function probe(provider, model, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: QUESTION },
              { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG}` } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { outcome: "could_not_look", detail: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }

    const json = await res.json();
    const text = (json?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return { outcome: "empty", detail: "HTTP 200 with no content" };
    if (readsRed(text)) return { outcome: "sees", detail: text.slice(0, 60) };
    return { outcome: "blind", detail: text.slice(0, 60) };
  } catch (error) {
    return { outcome: "could_not_look", detail: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const chain = freeChain();
  const lines = [];
  let confirmedFalse = 0;
  let checked = 0;

  for (const provider of chain) {
    const key = process.env[provider.keyEnv]?.trim();
    if (!key) {
      lines.push(`  UNCHECKED  ${provider.id} — no ${provider.keyEnv} in env`);
      continue;
    }

    // Only the ids this package CLAIMS can see. Probing the declared-blind
    // ones would double the cost to re-prove something already decided; the
    // claim is what rots.
    const claimed = providerModels(provider, process.env).filter(
      (m) => modelSeesImages(provider, m) === "yes",
    );

    if (claimed.length === 0) {
      lines.push(`  (none claimed) ${provider.id}`);
      continue;
    }

    for (const model of claimed) {
      const { outcome, detail } = await probe(provider, model, key);
      checked++;
      if (outcome === "sees") {
        lines.push(`  SEES       ${provider.id}/${model} — "${detail}"`);
      } else if (outcome === "could_not_look") {
        lines.push(`  UNCHECKED  ${provider.id}/${model} — ${detail}`);
      } else if (outcome === "empty") {
        confirmedFalse++;
        lines.push(`  EMPTY      ${provider.id}/${model} — ${detail} (200 is not an answer)`);
      } else {
        confirmedFalse++;
        lines.push(`  BLIND      ${provider.id}/${model} — answered "${detail}" (image not read)`);
      }
    }
  }

  console.log("Vision claims in freeChain(), probed with a real image:\n");
  console.log(lines.join("\n"));

  if (confirmedFalse > 0) {
    console.error(
      `\n${confirmedFalse} model(s) listed in visionModels did NOT read the image. ` +
        `Remove them from src/chain.ts or explain the exception beside the id.`,
    );
    process.exit(1);
  }
  console.log(
    `\n${checked} claim(s) probed, none refuted. ` +
      `UNCHECKED is not a pass — re-run with the missing key.`,
  );
}

await main();
