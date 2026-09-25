/**
 * "Does this key work, and what can it use?" — the question every settings
 * screen asks the moment a reader pastes a key.
 *
 * WHY THIS IS HERE AND NOT IN EACH APP
 *
 * OrangeCat answered half of it (does the key work) and threw the other half
 * away: it called each vendor's `/models`, looked at the status, and discarded
 * the list of models the key can actually reach — the one thing a picker needs
 * to offer the reader their best model instead of a text box. Loki had
 * nothing. A second app writing its own would repeat two traps found while
 * writing this one:
 *
 *   • OpenRouter's `/models` is a public catalogue. It answers 200 to a FAKE
 *     key, so a check against it accepts anything. The key is checked at
 *     `/key` instead (`ByokVendor.probe.checkPath`).
 *   • Rejections are not uniform. OpenAI, Anthropic, Groq, Mistral, DeepSeek,
 *     Together and Cerebras answer a bad key with 401; Google and xAI with
 *     400. So any non-2xx means "not working", reported in the vendor's own
 *     words — never a guessed reason.
 *
 * It makes network calls, so it is kept apart from `byok.ts` (pure data, safe
 * for a browser bundle). Call it from a server: vendors refuse browser-origin
 * requests, and the key should not be shipped to a client to probe anyway.
 */
import { byokVendor, type ByokVendorId } from "./byok.js";
import { readCatalog, type FetchCatalogOptions, type ModelRecord } from "./catalog-fetch.js";

export interface ByokProbe {
  /** The vendor accepted the key. */
  ok: boolean;
  /** HTTP status of the check, or null when the vendor could not be reached. */
  status: number | null;
  /** One sentence for the reader. On failure, the vendor's own words when it sent any. */
  message: string;
  /** Model ids this key can use, best suggestion first. Empty when unknown. */
  models: string[];
  /** The model to preselect — see `suggestByokModel`. Null when none could be read. */
  suggested: string | null;
}

/**
 * Check a reader's key against its vendor, and list the models it can use.
 *
 * Never throws and never echoes the key. A vendor that cannot be reached is
 * reported as such (`status: null`) — "we could not check" is not "your key is
 * wrong", and a settings screen must not tell a reader their valid key failed
 * because a vendor had a bad minute.
 */
export async function probeByokKey(
  vendorId: ByokVendorId | string,
  apiKey: string,
  opts: FetchCatalogOptions = {},
): Promise<ByokProbe> {
  const vendor = byokVendor(vendorId);
  if (!vendor) {
    return { ok: false, status: null, message: "Unknown provider.", models: [], suggested: null };
  }
  const key = apiKey.trim();
  if (!key || /[\r\n\s]/.test(key)) {
    return {
      ok: false,
      status: null,
      message: "That doesn't look like a key.",
      models: [],
      suggested: null,
    };
  }

  const spec = vendor.probe ?? {};
  const base = vendor.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    ...(spec.headers ?? {}),
    ...(spec.auth === "x-api-key" ? { "x-api-key": key } : { Authorization: `Bearer ${key}` }),
  };

  // Where the KEY is checked. Usually the models list itself; OpenRouter's is
  // public, so its key is checked separately.
  if (spec.checkPath) {
    const check = await readCatalog(`${base}${spec.checkPath}`, headers, opts);
    const verdict = judge(vendor.label, check.status, redact(check.vendorMessage, key));
    if (!verdict.ok) return { ...verdict, models: [], suggested: null };
  }

  const read = await readCatalog(`${base}/models`, headers, opts);
  if (!spec.checkPath) {
    const verdict = judge(vendor.label, read.status, redact(read.vendorMessage, key));
    if (!verdict.ok) return { ...verdict, models: [], suggested: null };
  }

  const records = read.records ?? [];
  const ranked = rankByokModels(records, { preferNamespaces: spec.preferNamespaces });
  const suggested = ranked[0] ?? null;
  return {
    ok: true,
    status: read.status,
    message:
      ranked.length > 0
        ? `Your ${vendor.label} key works — ${ranked.length} model${ranked.length === 1 ? "" : "s"} available.`
        : `Your ${vendor.label} key works. Type the model you want to use.`,
    models: ranked,
    suggested,
  };
}

/**
 * Vendors echo the key back in their errors — most masked ("sk-fakef***fake"),
 * but nothing obliges them to. What the reader is shown (and what an app might
 * log) must never carry it, so any occurrence is masked here.
 */
function redact(text: string | null, key: string): string | null {
  if (!text) return text;
  return text.split(key).join(`…${key.slice(-4)}`);
}

function judge(
  label: string,
  status: number | null,
  vendorMessage: string | null,
): { ok: boolean; status: number | null; message: string } {
  if (status === null) {
    return {
      ok: false,
      status,
      message: `Couldn't reach ${label} to check the key — try again in a moment.`,
    };
  }
  if (status >= 200 && status < 300) return { ok: true, status, message: "" };
  if (status === 429) {
    return {
      ok: false,
      status,
      message: `${label} is rate-limiting this key right now — it may still be valid.`,
    };
  }
  const said = vendorMessage ? ` ${label} says: "${vendorMessage}"` : "";
  return { ok: false, status, message: `${label} didn't accept this key.${said}` };
}

// ── Choosing the best model without naming any ────────────────────────────
//
// Model names change faster than any list can: on 2026-09-25 the newest ids
// were claude-opus-5.5, gpt-5.6-luna-pro and grok-4.7, none of which this
// package had ever heard of. So nothing below names a model. It reads the
// name for its TIER and the catalogue for its AGE, and prefers the newest
// model in the strongest tier the key can use. The reader can always pick
// another; this is only what the picker starts on.

/** Not chat models, or not usable as a chat default. */
const NOT_CHAT =
  /embed|whisper|tts|dall-?e|moderation|transcri|audio|realtime|speech|image|imagen|veo|lyria|vision-exp|search|davinci|babbage|rerank|guard|aqa|customtools|native-audio|:batch|-batch\b|computer-use|codex-mini|instruct-?ft/i;

/** Names vendors give their top tier. */
const TOP_TIER = /(?:^|[-/_.])(?:opus|pro|large|max|ultra)(?:[-_.]|$)/i;

/** Names vendors give their small, cheap tier. */
const SMALL_TIER = /(?:^|[-/_.])(?:mini|nano|lite|haiku|small|tiny|micro|flash-lite)(?:[-_.]|$)/i;

/** Speed-tuned variants: never the top suggestion, even when named "pro". */
const SPEED_VARIANT = /ultraspeed|turbo|instant|(?:^|[-_.])fast(?:[-_.]|$)/i;

/** Parameter count in billions when the id states one ("…-8b", "…70b…"). */
function paramsB(id: string): number | null {
  const m = /(?:^|[-_/.])(\d{1,4})b(?:[-_.]|$)/i.exec(id);
  return m ? Number(m[1]) : null;
}

function tierOf(id: string): number {
  const b = paramsB(id);
  if (SMALL_TIER.test(id) || (b !== null && b < 40)) return 0;
  const tier = TOP_TIER.test(id) ? 2 : 1;
  return SPEED_VARIANT.test(id) ? Math.min(tier, 1) : tier;
}

/**
 * The version a model id states, for vendors whose catalogue carries no dates
 * (Google's does not). "gemini-3.1-pro" → 3.1, "claude-opus-5.5" → 5.5. A
 * parameter count is not a version ("gpt-oss-120b" → none). A vendor's own
 * `-latest` alias ranks above every numbered id: it is the vendor saying
 * which one is newest, and it stays right when the numbers move.
 */
function versionOf(id: string): number {
  const name = id.slice(id.lastIndexOf("/") + 1);
  if (/(?:^|[-_.])latest(?:[-_.]|$)/i.test(name)) return Number.POSITIVE_INFINITY;
  const m = /(\d+(?:\.\d+)?)(?!\d|\.\d|b(?:[-_.]|$))/i.exec(name);
  return m ? Number(m[1]) : -1;
}

/** Previews and experiments rank after a stable id of the same standing. */
const UNSTABLE = /preview|(?:^|[-_.])exp(?:erimental)?(?:[-_.]|$)|beta/i;

export interface RankOptions {
  /**
   * For a router that serves every lab (OpenRouter): namespaces to rank first,
   * in order. A router's newest "pro" is as likely to be a speed-tuned
   * third-party build as a frontier model, and "the smartest model you have"
   * should not depend on who shipped last.
   */
  preferNamespaces?: readonly string[];
}

/**
 * Chat-usable model ids, best first: preferred namespace (routers only), then
 * strongest tier, then newest — by the vendor's date when it gives one, else
 * by the version in the name — then stable before preview, then the vendor's
 * own order. Pure: a settings screen can re-rank a list it already holds.
 */
export function rankByokModels(records: readonly ModelRecord[], opts: RankOptions = {}): string[] {
  const prefer = opts.preferNamespaces ?? [];
  const nsRank = (id: string) => {
    const i = prefer.findIndex((ns) => id.startsWith(ns));
    return i === -1 ? prefer.length : i;
  };
  const usable = records.filter(
    (r) =>
      !NOT_CHAT.test(r.id) && (r.outputModalities === null || r.outputModalities.includes("text")),
  );
  return usable
    .map((r, index) => ({
      r,
      index,
      ns: nsRank(r.id),
      tier: tierOf(r.id),
      version: versionOf(r.id),
      unstable: UNSTABLE.test(r.id) ? 1 : 0,
    }))
    .sort(
      (a, b) =>
        a.ns - b.ns ||
        b.tier - a.tier ||
        (b.r.created ?? -1) - (a.r.created ?? -1) ||
        b.version - a.version ||
        a.unstable - b.unstable ||
        a.index - b.index,
    )
    .map((x) => x.r.id);
}

/** The model a picker should start on for this list, or null for an empty one. */
export function suggestByokModel(
  records: readonly ModelRecord[],
  opts: RankOptions = {},
): string | null {
  return rankByokModels(records, opts)[0] ?? null;
}
