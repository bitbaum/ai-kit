/**
 * Web results → grounded Facts.
 *
 * This is the join that makes web search safe to give an agent. On its own,
 * search makes hallucination WORSE, not better: the model now has a pile of
 * plausible-sounding text from strangers, mixed into a context window beside
 * the user's real data, with nothing marking which sentence came from where.
 * The failure mode is not "the model made something up" — it is "the model
 * attributed a real sentence to the wrong source", and that is indistinguishable
 * from competence until someone clicks the link.
 *
 * The fix is the one the grounding harness already implements for database
 * rows. Every retrieved item becomes a `Fact` with a citation handle ([F3]) and
 * a `url` field, `verifyAnswer` then checks mechanically that every handle in
 * the answer exists and that proper nouns and numbers in the answer appear in
 * the evidence. A claim that cites nothing, or cites [F9] when only F1–F4 were
 * retrieved, is caught by a string check rather than by a reviewer's judgement.
 *
 * Two sets come out of here on purpose:
 *
 *   facts    — the citable records. Short, uniform, one block per source.
 *   evidence — the actual prose (snippets, page text). The verifier needs the
 *              words themselves to judge whether "€4.2 billion" in the answer
 *              was read or invented; a fact's five short fields are not enough
 *              of a corpus for that, and passing the page text AS a fact field
 *              would bury the citable metadata in ten thousand characters.
 */
import { makeFact, type Fact } from "../grounding/facts.js";
import type { PageOutcome, WebResult } from "./types.js";
import type { WebSearchResult } from "./search.js";

/** Search hits as citable records. Order is the engine's ranking, preserved. */
export function resultsToFacts(results: WebResult[], provider: string): Fact[] {
  return results.map((r) =>
    makeFact({
      kind: "web_result",
      subject: r.title,
      source: `web search (${provider})`,
      values: {
        title: r.title,
        url: r.url,
        published: r.published ?? null,
        snippet: r.snippet || null,
        engine: r.engine ?? provider,
      },
    }),
  );
}

/** One fetched page as a citable record. The prose goes to `pageEvidence`. */
export function pageToFact(page: Extract<PageOutcome, { ok: true }>): Fact {
  return makeFact({
    kind: "web_page",
    subject: page.title || page.url,
    source: "page read",
    values: {
      title: page.title || null,
      url: page.url,
      retrieved: new Date().toISOString().slice(0, 10),
      // Stated rather than implied: a model told the text is partial will say
      // "the first part of the page" instead of summarising a page it half read.
      truncated: page.truncated ? "yes — only the first part of the page was read" : "no",
    },
  });
}

/**
 * The prose a claim may draw on, one block per source, each labelled with the
 * fact id that licenses citing it.
 *
 * `facts` must be the ID-ASSIGNED array (post `assignFactIds`) and must line up
 * positionally with `results`. Passing un-assigned facts produces blocks labelled
 * `[]`, which is the bug this note exists to prevent.
 */
export function resultsEvidence(facts: Fact[], results: WebResult[]): string[] {
  return results.map((r, i) => {
    const id = facts[i]?.id ?? "";
    const head = `${id ? `[${id}] ` : ""}${r.title} — ${r.url}`;
    return r.snippet ? `${head}\n${r.snippet}` : head;
  });
}

/** A fetched page's readable text as one evidence block, labelled with its id. */
export function pageEvidence(fact: Fact, page: Extract<PageOutcome, { ok: true }>): string {
  const head = `[${fact.id}] ${page.title || page.url} — ${page.url}`;
  const tail = page.truncated ? "\n[…the rest of the page was not read]" : "";
  return `${head}\n${page.text}${tail}`;
}

/**
 * The sentence a model is shown when a lookup produced no usable answer.
 *
 * Written as an INSTRUCTION rather than a status code because that is what the
 * model actually acts on, and because the two cases need opposite replies: a
 * genuine "nothing out there" may be reported as a finding, while a backend
 * outage may not be reported at all — the honest reply is that we could not
 * look. Handing both to the model as `results: []` is how a broken API key
 * becomes a confident statement about the state of the world.
 */
export function describeEmptySearch(outcome: WebSearchResult): string {
  if (outcome.status === "nothing") {
    return (
      `The web search for "${outcome.query}" ran and returned no results. ` +
      `You may tell the user nothing was found for that phrasing, and suggest a different one. ` +
      `Do NOT present this as proof that the thing does not exist.`
    );
  }
  const reasons = outcome.attempts
    .map((a) => `${a.provider}: ${a.failure?.reason ?? a.outcome}`)
    .join(" | ");
  return (
    `The web search for "${outcome.query}" COULD NOT BE PERFORMED (${reasons}). ` +
    `Tell the user plainly that you could not search the web right now. ` +
    `You must NOT say that nothing was found, that no such thing exists, or describe any web content — ` +
    `you have not seen any.`
  );
}
