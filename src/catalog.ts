/**
 * catalog — has the vendor retired a model this chain still asks for?
 *
 * The chain exists because a single pinned free model is a scheduled outage.
 * That reasoning has a hole: the chain itself is a list of pinned ids, so it
 * rots too, and a chain whose first vendor is entirely dead is a slower version
 * of the failure it was built to prevent.
 *
 * Not hypothetical. On 2026-08-25 `freeChain()` was checked against the live
 * catalogues and FOUR of its nine ids were gone — both Groq models (the whole
 * first vendor) and two OpenRouter ids, one of them the preferred fallback. The
 * consumer that also used the Groq id for direct, unchained calls had been
 * silently failing for eight days.
 *
 * Why this lives in the package rather than in each app: the check is the same
 * everywhere, and the app that wrote its own first wrote it slightly
 * differently. One implementation, shared by name and by value.
 *
 * Cheap on purpose — one GET /models per provider and ZERO tokens. That is what
 * makes it schedulable, which is the whole difference between a check that runs
 * nightly and a command someone is supposed to remember. A tool-call probe
 * costs real tokens and cannot run on a timer; existence can.
 */

import { providerModels, type Env, type Provider } from "./chain.js";

export type CatalogVerdict = {
  provider: string;
  /**
   * Ids the vendor currently lists, or NULL when the catalogue could not be
   * read (no key, network failure, non-200, unparseable body).
   *
   * Null is not an empty list. Treating "I could not look" as "nothing is
   * there" reports every model as retired and invents an outage; treating it
   * as "all fine" hides a real one. Callers must handle three states.
   */
  live: string[] | null;
  /** Pinned ids confirmed present. Empty when `live` is null. */
  present: string[];
  /** Pinned ids the vendor no longer lists. Empty when `live` is null. */
  missing: string[];
  /** Pinned ids whose status is unknown because `live` is null. */
  unchecked: string[];
};

export type CheckCatalogOptions = {
  env?: Env;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** Ids listed by one provider, or null when the catalogue could not be read. */
async function liveIds(
  provider: Provider,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string[] | null> {
  try {
    const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body?.data)) return null;
    const ids = body.data
      .map((m) => (typeof m?.id === "string" ? m.id : ""))
      .filter((id): id is string => id.length > 0);
    // A catalogue that parses but lists nothing is a malformed answer, not a
    // vendor with no models. Refusing it keeps a bad response from reading as
    // total rot.
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Check every model a chain would try against what its vendor still lists.
 *
 * Honours the same env overrides `usableChain` does, so it checks the ids this
 * deployment would ACTUALLY call — not the library defaults an operator has
 * already routed around.
 */
export async function checkCatalog(
  chain: Provider[],
  opts: CheckCatalogOptions = {},
): Promise<CatalogVerdict[]> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  const out: CatalogVerdict[] = [];
  for (const provider of chain) {
    const pinned = providerModels(provider, env);
    const key = env[provider.keyEnv]?.trim();
    const live = key ? await liveIds(provider, key, fetchImpl, timeoutMs) : null;

    if (!live) {
      out.push({ provider: provider.id, live: null, present: [], missing: [], unchecked: pinned });
      continue;
    }
    const set = new Set(live);
    out.push({
      provider: provider.id,
      live,
      present: pinned.filter((m) => set.has(m)),
      missing: pinned.filter((m) => !set.has(m)),
      unchecked: [],
    });
  }
  return out;
}

/** True when any pinned id is confirmed gone. Unchecked providers do NOT count
 *  — an unreadable catalogue is not evidence of rot. */
export function hasRot(verdicts: CatalogVerdict[]): boolean {
  return verdicts.some((v) => v.missing.length > 0);
}

/** True when a whole vendor's models are gone, i.e. the chain has lost a link
 *  entirely. Worth separating: a chain that still has vendors is degraded, a
 *  chain that has lost one is back to being a single point of failure. */
export function deadProviders(verdicts: CatalogVerdict[]): string[] {
  return verdicts
    .filter((v) => v.live !== null && v.present.length === 0 && v.missing.length > 0)
    .map((v) => v.provider);
}

/** Human-readable report. Keeps could-not-look visibly distinct from a pass. */
export function catalogReport(verdicts: CatalogVerdict[]): string {
  const lines: string[] = [];
  for (const v of verdicts) {
    if (v.live === null) {
      lines.push(`? ${v.provider}: catalogue unreadable (no key, or the request failed) — ${v.unchecked.length} id(s) UNCHECKED`);
      for (const m of v.unchecked) lines.push(`    ? ${m}`);
      continue;
    }
    for (const m of v.present) lines.push(`  ok   ${v.provider}/${m}`);
    for (const m of v.missing) lines.push(`  GONE ${v.provider}/${m}`);
  }
  const dead = deadProviders(verdicts);
  if (dead.length) lines.push(`\nEVERY model is gone at: ${dead.join(", ")} — the chain has lost that vendor entirely.`);
  const unchecked = verdicts.reduce((n, v) => n + v.unchecked.length, 0);
  if (unchecked) lines.push(`\n${unchecked} id(s) could not be checked. That is not a pass for them.`);
  return lines.join("\n");
}
