/**
 * resolve — stop writing model ids down.
 *
 * ── The problem the chain did not solve ──────────────────────────────────────
 * `chain.ts` replaced one pinned model with a list of pinned models, and says so
 * itself: "a single pinned free model is not a configuration, it is a scheduled
 * outage." `catalog.ts` then noticed the list rots too, and added a check. But a
 * check only produces a SENTENCE. Somebody still has to read it, edit a file,
 * open a pull request, wait for CI, and deploy — and until they do, the app is
 * handing users a model that answers 404.
 *
 * That round trip is not hypothetical, it is this module's origin. On
 * 2026-09-13 a freshly scheduled health check alerted within minutes of its
 * first run: two ids in a consumer's registry were gone from OpenRouter. The
 * alert was correct, fast, and completely dependent on a human being available
 * to act on it. The vendor had published the truth the whole time.
 *
 * So: keep the declared list, but treat it as a PREFERENCE, and let the vendor's
 * own catalogue decide what is actually callable. A retirement stops being an
 * incident and becomes a no-op.
 *
 * ── Three rules, each paid for by a real failure ─────────────────────────────
 *
 * 1. NEVER SHRINK ON IGNORANCE. An unreadable catalogue leaves the declared
 *    list exactly as written and sets `unverified`. While building this, a
 *    checkout without GROQ_API_KEY got a 401, and the first draft of the probe
 *    printed "GONE" for both Groq models — both of which were live. Resolution
 *    that trusted that would let an expired key empty the chain.
 *
 * 2. DISCOVERY EXTENDS THE TAIL, NEVER THE HEAD. Declared ids were curated —
 *    in this package's case probed with a real tool call, because five of nine
 *    free models turned out to emit tool calls only as text. A discovered id
 *    has no such evidence behind it, so it may be a last resort and never a
 *    first choice.
 *
 * 3. DISCOVER ONLY WHAT THE VENDOR CALLS FREE, AND ONLY WHAT IT CALLS USABLE.
 *    Both halves matter, and both are read from the vendor rather than guessed:
 *
 *      - Price. Not the `:free` suffix — the published number. Checked live on
 *        2026-09-13, OpenRouter listed 19 ids ending `:free` and 22 priced at
 *        zero. Groq publishes prices too, and NONE of its models are zero, so
 *        discovery there correctly finds nothing and that vendor stays curated.
 *        A suffix heuristic would have gone looking for `:free` at a vendor
 *        that does not use the convention; a price check just declines.
 *
 *      - Suitability. Of the 19 free OpenRouter ids, one was
 *        `nemotron-3.5-content-safety` — a classifier, and the only one of the
 *        19 declaring `tools: false`. Two more zero-priced ids were
 *        `lyria-3-*`, which emit AUDIO. Adding all zero-priced models to a chat
 *        chain would have put a safety classifier and a music generator in
 *        front of a user asking a question. Requiring text output and declared
 *        tool support removes exactly those three and nothing else.
 *
 * ── What this is worth ───────────────────────────────────────────────────────
 * Measured against the live catalogue on 2026-09-13: `freeChain()` names five
 * OpenRouter ids by hand; nineteen zero-priced, text-out, tool-capable ids were
 * available. Same key, same account, no human — a free pool nearly four times
 * larger, which grows when the vendor adds models and shrinks when it removes
 * them, without anyone being told.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * Presence in a catalogue is not proof a model works. This package already
 * records two counter-examples: an id that answered "Provider returned error"
 * on probe, and one that returned HTTP 200 with EMPTY content. Resolution fixes
 * "the id does not exist"; it cannot fix "the id exists and misbehaves." That
 * is what the chain's own fallback, and observed health, are for. Declared
 * capability is a starting hypothesis — traffic is the evidence.
 */

import { providerModels, type Env, type Provider } from "./chain.js";
import { fetchCatalog, type ModelRecord } from "./catalog-fetch.js";

/** What a discovered model must prove about itself before it joins the tail. */
export type Requirements = {
  /** Vendor must publish a price and it must be zero. Default true. */
  free?: boolean;
  /** Vendor must declare text as its only output modality. Default true. */
  textOnly?: boolean;
  /** Vendor must declare tool/function calling. Default true. */
  tools?: boolean;
  /** Minimum published context window, when the vendor publishes one. */
  minContext?: number;
};

export type ResolveOptions = {
  env?: Env;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Append live models the declaration never named. Default true — that is the
   * half that makes the pool GROW without a human. Set false to verify the
   * declared list against the catalogue and nothing more.
   */
  discover?: boolean;
  /** What a discovered model must declare. See Requirements. */
  require?: Requirements;
  /**
   * Cap on discovered ids appended per provider. Default 10.
   *
   * A cap, not a preference: the chain is walked in order on failure, so an
   * unbounded tail turns one bad minute at a vendor into dozens of sequential
   * requests before the caller sees an error.
   */
  maxDiscovered?: number;
  /** Clock injection for tests. Default `Date.now`. */
  now?: () => number;
};

export type ProviderResolution = {
  provider: string;
  /** The ids to actually try, in order: kept declarations, then discovered. */
  models: string[];
  /** Declared ids the vendor still lists. */
  kept: string[];
  /**
   * Declared ids the vendor no longer lists. Dropped from `models` — this is
   * the rot, already routed around rather than merely reported.
   */
  dropped: string[];
  /** Live ids the declaration never named, appended after the kept ones. */
  discovered: string[];
  /**
   * True when the catalogue could not be read, so `models` is the declaration
   * verbatim and NOTHING here was verified. `dropped` is empty because no id
   * was confirmed gone — not because none is.
   */
  unverified: boolean;
  /** Ids in `models` the vendor says will stop working, with the date. */
  expiring: Array<{ model: string; on: string }>;
};

const DEFAULTS: Required<Omit<Requirements, "minContext">> = {
  free: true,
  textOnly: true,
  tools: true,
};

/**
 * Does this record satisfy the requirement, reading "the vendor did not say" as
 * a failure?
 *
 * Silence is refused rather than assumed. A model that does not declare a price
 * might be free; if it is not, discovery has quietly started spending money,
 * which is the one failure here with a bill attached. The cost of being wrong is
 * asymmetric, so the default leans to declining.
 */
function meets(m: ModelRecord, req: Requirements): boolean {
  const want = { ...DEFAULTS, ...req };
  if (want.free && m.costsNothing !== true) return false;
  if (want.textOnly && !(m.outputModalities?.length === 1 && m.outputModalities[0] === "text"))
    return false;
  if (want.tools && m.tools !== true) return false;
  if (req.minContext !== undefined && (m.contextLength ?? 0) < req.minContext) return false;
  return true;
}

/** Has the vendor's own stated end-date already passed? */
function expired(m: ModelRecord, now: number): boolean {
  if (!m.expiresOn) return false;
  const t = Date.parse(`${m.expiresOn}T23:59:59Z`);
  return Number.isFinite(t) && t < now;
}

/**
 * Resolve one chain against what its vendors currently offer.
 *
 * Costs one GET /models per provider and ZERO tokens — the same property that
 * made the catalogue check schedulable makes this callable on a warm path, and
 * consumers are expected to cache the result rather than resolve per request.
 */
export async function resolveChain(
  chain: Provider[],
  opts: ResolveOptions = {},
): Promise<ProviderResolution[]> {
  const env = opts.env ?? process.env;
  const discover = opts.discover ?? true;
  const req = opts.require ?? {};
  const maxDiscovered = opts.maxDiscovered ?? 10;
  const now = (opts.now ?? Date.now)();

  const out: ProviderResolution[] = [];
  for (const provider of chain) {
    const declared = providerModels(provider, env);
    const records = await fetchCatalog(provider.baseUrl, env[provider.keyEnv], {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });

    // Rule 1. Could not look ⇒ change nothing, and say so.
    if (!records) {
      out.push({
        provider: provider.id,
        models: declared,
        kept: [],
        dropped: [],
        discovered: [],
        unverified: true,
        expiring: [],
      });
      continue;
    }

    const byId = new Map(records.map((r) => [r.id, r]));
    const kept = declared.filter((m) => {
      const rec = byId.get(m);
      return rec !== undefined && !expired(rec, now);
    });
    const dropped = declared.filter((m) => !kept.includes(m));

    // Rule 2. Discovered ids go after the curated ones, never before.
    const discovered = discover
      ? records
          .filter((r) => !declared.includes(r.id) && !expired(r, now) && meets(r, req))
          .map((r) => r.id)
          .sort()
          .slice(0, maxDiscovered)
      : [];

    const models = [...kept, ...discovered];
    const expiring = models
      .map((m) => ({ model: m, on: byId.get(m)?.expiresOn ?? null }))
      .filter((e): e is { model: string; on: string } => e.on !== null);

    out.push({
      provider: provider.id,
      models,
      kept,
      dropped,
      discovered,
      unverified: false,
      expiring,
    });
  }
  return out;
}

/**
 * Fold a resolution back into providers, ready for `usableChain`.
 *
 * A provider whose every model resolved away is left with an EMPTY model list
 * rather than being dropped from the chain. `usableChain` already skips links
 * with nothing to try, and keeping the row means the vendor still appears in
 * reports — a silently vanished provider is how a chain quietly becomes a
 * single point of failure without anyone noticing.
 */
export function applyResolution(chain: Provider[], resolved: ProviderResolution[]): Provider[] {
  const byId = new Map(resolved.map((r) => [r.provider, r]));
  return chain.map((p) => {
    const r = byId.get(p.id);
    return r ? { ...p, models: r.models } : p;
  });
}

/** True when any declared id was confirmed gone and routed around. */
export function routedAroundRot(resolved: ProviderResolution[]): boolean {
  return resolved.some((r) => r.dropped.length > 0);
}

/**
 * Providers left with nothing to try, despite a readable catalogue.
 *
 * Kept separate from "could not look" on purpose: a vendor whose catalogue
 * answered and contained none of our models is a real lost link, while an
 * unreadable one is an unknown. Collapsing them produces either a false alarm
 * every time a key expires, or silence when a vendor actually goes away.
 */
export function emptyProviders(resolved: ProviderResolution[]): string[] {
  return resolved.filter((r) => !r.unverified && r.models.length === 0).map((r) => r.provider);
}

/** Human-readable report. Could-not-look stays visibly distinct from a pass. */
export function resolutionReport(resolved: ProviderResolution[]): string {
  const lines: string[] = [];
  for (const r of resolved) {
    if (r.unverified) {
      lines.push(
        `? ${r.provider}: catalogue unreadable — using the declared ${r.models.length} id(s) UNVERIFIED`,
      );
      continue;
    }
    lines.push(
      `  ${r.provider}: ${r.models.length} model(s) — ${r.kept.length} declared, ${r.discovered.length} discovered`,
    );
    for (const m of r.dropped) lines.push(`    GONE, routed around: ${m}`);
    for (const m of r.discovered) lines.push(`    + ${m}`);
    for (const e of r.expiring) lines.push(`    ! ${e.model} — vendor says it ends ${e.on}`);
  }
  const empty = emptyProviders(resolved);
  if (empty.length)
    lines.push(
      `\nNothing left to try at: ${empty.join(", ")} — that vendor is gone from the chain.`,
    );
  return lines.join("\n");
}
