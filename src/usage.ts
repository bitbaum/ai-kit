/**
 * Showing a person their AI budget — what the numbers MEAN, not only how big
 * they are.
 *
 * ── Why this is in the package ───────────────────────────────────────────────
 * Every app in this fleet meters AI, and every one of them used to show it as a
 * bare meter: "57% used, resets in 1 h 33 min". That is accurate and tells a
 * person nothing they can do — whether that pace lasts the day, whether the
 * limit is something they keep hitting, what the assistant forgets as a chat
 * grows, and what to press. Loki and OrangeCat each grew the other half in
 * October 2026, separately, with the same rules and slightly different
 * sentences. Two copies of a sentence are two sentences, and the third app
 * would have written a third. So the half that is not about any one product
 * lives here:
 *
 *   paceForecast / paceLine — does today's rate last the day, or run out when?
 *   weekSummary            — the last seven days from per-day rows, including
 *                            the days the cap decided when the person stopped
 *   refillsIn              — "in 4 hours", "in under a minute", "now"
 *   admissionsLeft         — how many answers a remainder buys, counted the
 *                            way an admission gate actually admits them
 *   historyWindowLine      — what the assistant still reads of a conversation
 *   UsageAction            — a lever and its consequence, never a bare verb
 *
 * What each app keeps: the reads (its own tables), the plan names and prices
 * (its own config), and which levers are open. Those are product facts, and a
 * package that knew them would be a package that lies about the next product.
 *
 * ── The rules every helper here keeps ────────────────────────────────────────
 * 1. A number that implies no action is decoration. Sentences say what happens
 *    next; levers say what pressing them changes.
 * 2. Absent is not zero. A week that could not be read is `null`, never
 *    "0 messages" — "could not look" and "nothing happened" are opposite claims.
 * 3. No forecast from one sample. One early answer stretched over 24 hours is
 *    a scare, not a forecast.
 * 4. Count in the person's unit (answers, messages), and format numbers with
 *    the APP's formatter — pass `format`, so a page never groups digits two
 *    different ways.
 *
 * Pure: no clock beyond the `now` it is handed, no storage, no I/O.
 */

import { utcDayElapsed } from "./fair-share.js";

/** Formats a count for display. Apps pass their own so every number on a page agrees. */
export type FormatCount = (n: number) => string;

const defaultFormat: FormatCount = (n) => n.toLocaleString("en-US");

/** "1 message", "3 messages". `word` is singular; plural adds "s" unless given. */
export function countOf(
  n: number,
  word: string,
  opts: { plural?: string; format?: FormatCount } = {},
): string {
  const format = opts.format ?? defaultFormat;
  return `${format(n)} ${n === 1 ? word : (opts.plural ?? `${word}s`)}`;
}

/** The next midnight UTC — when the vendors' free tiers, and so every daily share, refill. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

/** "16:40 UTC" for a fraction of the UTC day (clamped to 0..1). */
export function clockAt(dayFraction: number): string {
  const f = Number.isFinite(dayFraction) ? Math.min(1, Math.max(0, dayFraction)) : 0;
  const mins = Math.round(f * 24 * 60);
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
}

/**
 * "in 4 hours", "in 12 minutes", "in under a minute", "now". Null when the
 * moment is unknown — the caller says "unknown", never a guessed time.
 *
 * Tested against the raw delta, not rounded minutes: 40 seconds rounds UP to
 * one minute, so a rounded check never reaches the sub-minute case.
 */
export function refillsIn(at: Date | string | number | null, now: number): string | null {
  if (at === null) return null;
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(t)) return null;
  const delta = t - now;
  if (delta <= 0) return "now";
  if (delta < 60_000) return "in under a minute";
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * How many answers `remaining` tokens buy, counted the way an admission gate
 * admits them: each turn must first fit the gate's ESTIMATE (`admitCost`), and
 * then costs what turns really cost (`perAnswer`). So the count is successive
 * admissions — one while the estimate fits, plus one per real answer above it —
 * never a bare division, which would promise ten cheap answers on a remainder
 * the gate refuses after one.
 */
export function admissionsLeft(remaining: number, admitCost: number, perAnswer: number): number {
  if (!Number.isFinite(remaining) || remaining < admitCost || admitCost <= 0) return 0;
  const per = perAnswer > 0 ? perAnswer : admitCost;
  return 1 + Math.floor((remaining - admitCost) / per);
}

export type PaceForecast =
  | { lastsTheDay: true }
  | {
      lastsTheDay: false;
      /** Fraction of the UTC day at which the limit is reached at today's rate. */
      reachesAt: number;
      /** The same moment as "16:40 UTC". */
      clock: string;
    };

/** Below this much used, there is no rate to project. */
export const PACE_MIN_USED = 2;
/** Below this fraction of the day, a rate is noise. */
export const PACE_MIN_DAY_FRACTION = 0.05;

/**
 * At today's rate, does `limit` last the day — and if not, when is it reached?
 *
 * Null when there is nothing honest to say: no limit, already at it, too few
 * samples, or too early in the day. `minUsed` is in the same unit as `used`
 * (two messages; two turns' worth of tokens) — the caller knows what one is.
 */
export function paceForecast(input: {
  used: number;
  limit: number;
  now: Date;
  /** Minimum `used` before projecting. Defaults to PACE_MIN_USED. */
  minUsed?: number;
}): PaceForecast | null {
  const { used, limit } = input;
  if (!(limit > 0) || used >= limit) return null;
  const elapsed = utcDayElapsed(input.now);
  if (used < (input.minUsed ?? PACE_MIN_USED) || elapsed < PACE_MIN_DAY_FRACTION) return null;
  if (used / elapsed <= limit) return { lastsTheDay: true };
  const reachesAt = (limit / used) * elapsed;
  return { lastsTheDay: false, reachesAt, clock: clockAt(reachesAt) };
}

/**
 * The forecast as one sentence. `subject` is what lasts or runs out, in the
 * product's words ("your share", "your 10 messages"); `plural` picks the verb;
 * `then` is appended after a run-out, punctuation included (", then Cat waits
 * until midnight UTC").
 */
export function paceLine(
  forecast: PaceForecast | null,
  opts: { subject: string; plural?: boolean; then?: string },
): string | null {
  if (!forecast) return null;
  if (forecast.lastsTheDay) {
    return `At today's pace ${opts.subject} ${opts.plural ? "last" : "lasts"} the whole day.`;
  }
  return `At today's pace ${opts.subject} ${opts.plural ? "run" : "runs"} out around ${forecast.clock}${opts.then ?? ""}.`;
}

export interface WeekSummary {
  /** Sum of `used` across the days given. */
  total: number;
  /** Days with any use. */
  activeDays: number;
  /** Days on which `used` reached `limit`. 0 when no limit is given. */
  cappedDays: number;
}

/**
 * The last seven days from per-day rows. Null for no rows or an all-zero week:
 * a week with nothing in it is not drawn, because "0 this week" reads as a
 * measurement and an empty ledger is not one.
 *
 * `limit` is TODAY's cap. A day spent on a smaller plan before an upgrade would
 * otherwise read as capped at the larger number.
 */
export function weekSummary(
  days: readonly { used: number }[] | null,
  limit?: number | null,
): WeekSummary | null {
  if (!days) return null;
  const total = days.reduce((n, d) => n + Math.max(0, d.used || 0), 0);
  if (total === 0) return null;
  return {
    total,
    activeDays: days.filter((d) => d.used > 0).length,
    cappedDays: limit && limit > 0 ? days.filter((d) => d.used >= limit).length : 0,
  };
}

/**
 * What the assistant still reads of a conversation, said once in the same
 * words everywhere. This is the number a person meets as "it forgot what I
 * said"; stated, it is a limit they can plan around.
 *
 *   historyWindowLine({ assistant: "Cat", items: 20, unit: "message",
 *                       memory: "Memory" })
 *   → "In a conversation Cat reads your last 20 messages; anything older it no
 *      longer sees. What should outlast that belongs in Memory, which Cat
 *      recalls in every chat."
 */
export function historyWindowLine(opts: {
  assistant: string;
  items: number;
  /** Singular: "message", "turn". */
  unit: string;
  /** "each trimmed to about 600 characters" — when the window also shortens each item. */
  trimmedChars?: number;
  /** Where lasting facts go ("Memory"). Omit when the product has no such place. */
  memory?: string;
  format?: FormatCount;
}): string {
  const format = opts.format ?? defaultFormat;
  const trimmed =
    opts.trimmedChars && opts.trimmedChars > 0
      ? `, each trimmed to about ${format(opts.trimmedChars)} characters`
      : "";
  const memory = opts.memory
    ? ` What should outlast that belongs in ${opts.memory}, which ${opts.assistant} recalls in every chat.`
    : "";
  return (
    `In a conversation ${opts.assistant} reads your last ${countOf(opts.items, opts.unit, { format })}` +
    `${trimmed}; anything older it no longer sees.${memory}`
  );
}

/**
 * One thing a person can do about their budget. `why` is the consequence and is
 * required: "Upgrade" alone is a guess; "Add your key — no daily cap, your
 * provider bills you" is a decision. No `href` means the page performs it.
 */
export interface UsageAction<Id extends string = string> {
  id: Id;
  label: string;
  why: string;
  href?: string;
}

/** One number explained in plain words, for a "What these numbers mean" list. */
export interface UsageExplanation {
  title: string;
  body: string;
}

/** The reset, explained — the same words in every product, because the reason is the same. */
export const UTC_RESET_EXPLANATION: UsageExplanation = {
  title: "Resets at midnight UTC",
  body:
    "Because that is when the model providers' free allowances refill, so the counter follows " +
    "their clock, not yours. Unused allowance does not roll over.",
};
