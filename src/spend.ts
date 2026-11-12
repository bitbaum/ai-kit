/**
 * Paid AI is off unless a feature opts in, and capped when it does.
 *
 * WHY THIS EXISTS
 * ---------------
 * `freeChain()` used to put Google second, on GEMINI_API_KEY, described as a
 * free per-project tier. The key was fleet-wide and the project had billing,
 * so every app on the box fell through to Google whenever Groq's pool was
 * spent: about $567 on 10-11 Nov 2026. Google is not in the chain any more;
 * it bills. This module is the rule that keeps any paid vendor from coming
 * back the same way:
 *
 * - A provider is PAID when it is marked so, or when it is one of the vendors
 *   that bill per call (Google's Gemini API, xAI, Anthropic, OpenAI), by host
 *   or by key name. A reader's own key (`byok`) is theirs, never paid by us.
 * - The kill switch AI_PAID_DISABLED is ON when unset: no paid call at all.
 *   Only "0", "false", "off" or "no" turns it off.
 * - With the switch off, an app still has to opt in: AI_PAID_OK, or
 *   {PREFIX}_AI_PAID_OK, truthy.
 * - Then daily caps (UTC day) bind: the app's own row AND the fleet's, both
 *   must have room. xAI has its own, smaller cap drawn from fleet headroom
 *   (default 0; 2 calls / 2,000 in / 1,000 out once opted in).
 * - A cap that is reached is said ("limit reached") and logged. The walk does
 *   not step onto another paid vendor to get round it.
 * - Free links (Groq, OpenRouter `:free`) cost nothing and do not count
 *   against paid caps; a loop guard still stops a runaway (5,000 calls a day).
 *
 * Pure decisions over an injectable ledger. The default ledger is this
 * process's memory; a box that wants one fleet-wide count across apps sets
 * a shared ledger (see `setSpendLedger`, and `fileSpendLedger` in ./server).
 */
import type { Env, Link, Provider } from "./chain.js";

/** Daily usage, or a daily allowance of it. */
export type SpendCaps = { calls: number; inputTokens: number; outputTokens: number };

const ZERO: SpendCaps = { calls: 0, inputTokens: 0, outputTokens: 0 };

/** Hosts whose APIs bill per call. */
const PAID_HOSTS = [
  "generativelanguage.googleapis.com",
  "api.x.ai",
  "api.anthropic.com",
  "api.openai.com",
];

/** Key names of vendors that bill per call (also with an app prefix, e.g. SOLON_GEMINI_API_KEY). */
const PAID_KEY_NAMES = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "GROK_DEPLOYMENT_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

const XAI_KEY_NAMES = ["XAI_API_KEY", "GROK_API_KEY", "GROK_DEPLOYMENT_KEY"];

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

const endsWithKey = (keyEnv: string, names: string[]) =>
  names.some((n) => keyEnv === n || keyEnv.endsWith(`_${n}`));

/** Is this an xAI (Grok API) provider? */
export function isXaiProvider(provider: Provider): boolean {
  return hostOf(provider.baseUrl) === "api.x.ai" || endsWithKey(provider.keyEnv, XAI_KEY_NAMES);
}

/**
 * Does calling this provider cost the platform money? A reader's own key
 * never does (byok); an explicit `paid` flag decides; otherwise the vendor's
 * host or key name.
 */
export function isPaidProvider(provider: Provider): boolean {
  if (provider.byok) return false;
  if (provider.paid !== undefined) return provider.paid;
  return (
    PAID_HOSTS.includes(hostOf(provider.baseUrl)) || endsWithKey(provider.keyEnv, PAID_KEY_NAMES)
  );
}

const OFF_WORDS = new Set(["0", "false", "off", "no"]);
const ON_WORDS = new Set(["1", "true", "on", "yes"]);

function read(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** The kill switch. ON when unset: only an explicit "0/false/off/no" lets paid calls through. */
export function paidDisabled(env: Env = process.env): boolean {
  const raw = read(env, "AI_PAID_DISABLED")?.toLowerCase();
  return raw === undefined ? true : !OFF_WORDS.has(raw);
}

/** Canonical app key: upper case, "-" and spaces read as "_". */
export function appKey(app: string | null | undefined): string {
  return (app ?? "")
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "_");
}

/** Has this app opted into paid providers (AI_PAID_OK or {PREFIX}_AI_PAID_OK)? */
export function paidOptedIn(app: string | null | undefined, env: Env = process.env): boolean {
  const own = appKey(app);
  const values = [read(env, "AI_PAID_OK"), own ? read(env, `${own}_AI_PAID_OK`) : undefined];
  return values.some((v) => v !== undefined && ON_WORDS.has(v.toLowerCase()));
}

/** May this app call a paid provider at all (switch off, and opted in)? */
export function paidAllowed(app: string | null | undefined, env: Env = process.env): boolean {
  return !paidDisabled(env) && paidOptedIn(app, env);
}

// ── caps ────────────────────────────────────────────────────────────────────

/** The fleet's daily paid allowance, across every app (CHF 10/month owner ceiling). */
export const FLEET_DAILY_PAID: SpendCaps = {
  calls: 90,
  inputTokens: 120_000,
  outputTokens: 60_000,
};

const SMALL: SpendCaps = { calls: 1, inputTokens: 1_200, outputTokens: 600 };
const TINY: SpendCaps = { calls: 1, inputTokens: 800, outputTokens: 400 };

/**
 * Named apps' daily paid caps. About 60% of the fleet cap is named, so an app
 * nobody listed still has headroom: calls 51 of 90, input 71,800 of 120,000,
 * output 35,900 of 60,000 (pinned by a test).
 */
export const APP_DAILY_PAID: Readonly<Record<string, SpendCaps>> = {
  ORANGECAT: { calls: 15, inputTokens: 22_000, outputTokens: 11_000 },
  HEIDI: { calls: 9, inputTokens: 14_000, outputTokens: 7_000 },
  LOKI: { calls: 6, inputTokens: 10_000, outputTokens: 5_000 },
  SUBSTRATA: { calls: 5, inputTokens: 7_000, outputTokens: 3_500 },
  SOLON: ZERO,
  OPENCLAW: ZERO,
  HIRNLI: SMALL,
  BIASLENS: SMALL,
  SKIF: SMALL,
  CAUSIUS: SMALL,
  DIPLODOCTOR: SMALL,
  AOZ: SMALL,
  EVIG: SMALL,
  BOTSMANN: SMALL,
  KIVVI: SMALL,
  DATACAT: SMALL,
  SURF_YOUR_LIFE: SMALL,
  TRUTHSEEKER: SMALL,
  VITAREBA: SMALL,
  KELLER: SMALL,
  CENTER_COM: SMALL,
  SBB: TINY,
};

/** Apps with no AI at all: nothing paid, ever. */
export const NO_AI_APPS: readonly string[] = [
  "PETVITY",
  "REPARATURBONUS",
  "MORULIA",
  "SINK",
  "CAMILLE",
  "FARMHOUSE",
  "XHIVA",
  "FARMACIADELPARCO",
];

/** Other names an app is known by (its freeChain prefix, its deploy id). */
export const APP_ALIASES: Readonly<Record<string, string>> = {
  AOZ_WOHNEN: "AOZ",
  AOZ_BEGLEITUNG: "AOZ",
  REVAMP_INFO: "HIRNLI",
  REVAMPIT: "EVIG",
  S_INK: "SINK",
  SBB_FUNDBUERO: "SBB",
};

/** An app nobody named: small, and never unlimited. */
export const UNKNOWN_APP_DAILY_PAID: SpendCaps = TINY;

/** The canonical row an app id resolves to. */
export function canonicalApp(app: string | null | undefined): string {
  const key = appKey(app);
  return APP_ALIASES[key] ?? key;
}

function capsFromEnv(env: Env, prefix: string, base: SpendCaps): SpendCaps {
  const num = (name: string, fallback: number) => {
    const raw = read(env, name);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    calls: num(`${prefix}_CALLS`, base.calls),
    inputTokens: num(`${prefix}_INPUT_TOKENS`, base.inputTokens),
    outputTokens: num(`${prefix}_OUTPUT_TOKENS`, base.outputTokens),
  };
}

/** An app's daily paid caps: its row (or the unknown default), then {PREFIX}_DAILY_PAID_* from env. */
export function appPaidCaps(app: string | null | undefined, env: Env = process.env): SpendCaps {
  const canon = canonicalApp(app);
  const row = NO_AI_APPS.includes(canon) ? ZERO : (APP_DAILY_PAID[canon] ?? UNKNOWN_APP_DAILY_PAID);
  // The app's own prefix wins over the canonical one, so a deploy can tune itself.
  const own = appKey(app);
  const viaCanon = capsFromEnv(env, `${canon}_DAILY_PAID`, row);
  return own && own !== canon ? capsFromEnv(env, `${own}_DAILY_PAID`, viaCanon) : viaCanon;
}

/** The fleet's daily paid caps (AI_FLEET_DAILY_PAID_*). */
export function fleetPaidCaps(env: Env = process.env): SpendCaps {
  return capsFromEnv(env, "AI_FLEET_DAILY_PAID", FLEET_DAILY_PAID);
}

/** xAI, once an app has opted in: 2 calls / 2,000 in / 1,000 out a day, or {PREFIX}_DAILY_XAI_*. */
export const XAI_OPTED_IN_DAILY: SpendCaps = { calls: 2, inputTokens: 2_000, outputTokens: 1_000 };

export function xaiCaps(app: string | null | undefined, env: Env = process.env): SpendCaps {
  if (!paidOptedIn(app, env)) return ZERO;
  return capsFromEnv(env, `${canonicalApp(app)}_DAILY_XAI`, XAI_OPTED_IN_DAILY);
}

/** The loop guard on free calls (AI_APP_DAILY_FREE_CALLS, or {PREFIX}_DAILY_FREE_CALLS). */
export const APP_DAILY_FREE_CALLS = 5_000;

export function freeCallCap(app: string | null | undefined, env: Env = process.env): number {
  const num = (name: string) => {
    const raw = read(env, name);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  };
  return (
    num(`${canonicalApp(app)}_DAILY_FREE_CALLS`) ??
    num("AI_APP_DAILY_FREE_CALLS") ??
    APP_DAILY_FREE_CALLS
  );
}

/** Solon's translate feature on the free path: a named daily cap (SOLON_TRANSLATE_DAILY_CALLS). */
export const SOLON_TRANSLATE_DAILY_CALLS = 2_000;

// ── the ledger ─────────────────────────────────────────────────────────────

/** Where usage is counted. `scope` is "fleet", "app:<ID>", "xai:<ID>" or "free:<ID>". */
export interface SpendLedger {
  get(scope: string, day: string): SpendCaps;
  add(scope: string, day: string, usage: SpendCaps): void;
}

export function memorySpendLedger(): SpendLedger {
  const rows = new Map<string, SpendCaps>();
  return {
    get: (scope, day) => rows.get(`${day}|${scope}`) ?? { ...ZERO },
    add: (scope, day, u) => {
      const k = `${day}|${scope}`;
      const cur = rows.get(k) ?? { ...ZERO };
      rows.set(k, {
        calls: cur.calls + u.calls,
        inputTokens: cur.inputTokens + u.inputTokens,
        outputTokens: cur.outputTokens + u.outputTokens,
      });
      // Yesterday is never read again.
      for (const key of rows.keys()) if (!key.startsWith(`${day}|`)) rows.delete(key);
    },
  };
}

let ledger: SpendLedger = memorySpendLedger();

/** Use a shared ledger (one count across apps on a box). Returns the previous one. */
export function setSpendLedger(next: SpendLedger): SpendLedger {
  const prev = ledger;
  ledger = next;
  return prev;
}

export function spendLedger(): SpendLedger {
  return ledger;
}

/** The UTC day a count belongs to. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ── the gate ───────────────────────────────────────────────────────────────

/** Why a link was not called. */
export type SpendRefusal =
  "paid-disabled" | "paid-not-opted-in" | "app-cap" | "fleet-cap" | "xai-cap" | "free-cap";

export type SpendVerdict =
  | { ok: true; paid: boolean; scopes: string[] }
  | { ok: false; reason: SpendRefusal; message: string };

const room = (used: SpendCaps, caps: SpendCaps, estimateIn: number) =>
  used.calls + 1 <= caps.calls &&
  used.inputTokens + estimateIn <= caps.inputTokens &&
  used.outputTokens < caps.outputTokens;

/** The app a link spends for: the caller's, the provider's env prefix, or AI_APP_ID. */
export function spendApp(link: Link, explicit?: string | null, env: Env = process.env): string {
  return explicit?.trim() || link.provider.envPrefix || read(env, "AI_APP_ID") || "AI";
}

/**
 * May this link be called now? Pure over the ledger: nothing is counted here
 * (see `recordSpend`). `estimateIn` is the input tokens the call will send.
 */
export function checkSpend(
  link: Link,
  app: string,
  env: Env = process.env,
  options: { estimateIn?: number; now?: number; ledger?: SpendLedger } = {},
): SpendVerdict {
  const day = utcDay(options.now);
  const book = options.ledger ?? ledger;
  const canon = canonicalApp(app);
  const estimateIn = Math.max(0, Math.floor(options.estimateIn ?? 0));
  const vendor = `${link.provider.id}/${link.model}`;

  if (!isPaidProvider(link.provider)) {
    const cap = freeCallCap(app, env);
    const used = book.get(`free:${canon}`, day);
    return used.calls + 1 <= cap
      ? { ok: true, paid: false, scopes: [`free:${canon}`] }
      : {
          ok: false,
          reason: "free-cap",
          message: `${vendor}: limit reached — ${canon || "this app"} made ${used.calls} free AI calls today (loop guard ${cap}).`,
        };
  }

  if (paidDisabled(env)) {
    return {
      ok: false,
      reason: "paid-disabled",
      message: `${vendor}: paid AI is switched off (AI_PAID_DISABLED). Free providers only.`,
    };
  }
  if (!paidOptedIn(app, env)) {
    return {
      ok: false,
      reason: "paid-not-opted-in",
      message: `${vendor}: a paid provider, and ${canon || "this app"} has not opted in (AI_PAID_OK).`,
    };
  }

  const fleet = book.get("fleet", day);
  if (!room(fleet, fleetPaidCaps(env), estimateIn)) {
    return {
      ok: false,
      reason: "fleet-cap",
      message: `${vendor}: limit reached — the fleet's daily paid allowance is used up.`,
    };
  }
  if (isXaiProvider(link.provider)) {
    const used = book.get(`xai:${canon}`, day);
    return room(used, xaiCaps(app, env), estimateIn)
      ? { ok: true, paid: true, scopes: ["fleet", `xai:${canon}`] }
      : {
          ok: false,
          reason: "xai-cap",
          message: `${vendor}: limit reached — ${canon}'s daily xAI allowance is used up.`,
        };
  }
  const used = book.get(`app:${canon}`, day);
  return room(used, appPaidCaps(app, env), estimateIn)
    ? { ok: true, paid: true, scopes: ["fleet", `app:${canon}`] }
    : {
        ok: false,
        reason: "app-cap",
        message: `${vendor}: limit reached — ${canon}'s daily paid allowance is used up.`,
      };
}

/** Count a call (and its tokens, once known) against every scope it was checked under. */
export function recordSpend(
  scopes: string[],
  usage: Partial<SpendCaps>,
  options: { now?: number; ledger?: SpendLedger } = {},
): void {
  const book = options.ledger ?? ledger;
  const day = utcDay(options.now);
  const u: SpendCaps = {
    calls: usage.calls ?? 0,
    inputTokens: Math.max(0, Math.floor(usage.inputTokens ?? 0)),
    outputTokens: Math.max(0, Math.floor(usage.outputTokens ?? 0)),
  };
  for (const scope of scopes) book.add(scope, day, u);
}

/** Thrown when nothing was called because every usable link was refused by the spend rules. */
export class SpendLimitError extends Error {
  readonly reasons: SpendRefusal[];
  constructor(messages: string[], reasons: SpendRefusal[]) {
    super(`limit reached: ${messages.join("; ")}`);
    this.name = "SpendLimitError";
    this.reasons = reasons;
  }
}
