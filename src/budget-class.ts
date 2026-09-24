/**
 * Priority classes over ONE daily budget: readers first, background jobs from
 * a capped, reserved slice.
 *
 * `fairShare` divides a day's free budget between USERS. It has no notion of
 * WHO is spending on whose behalf, and an app has two very different spenders
 * on the same keys: a person waiting on an answer, and a scheduled job that
 * would be just as happy to run tomorrow. Measured on substrata 2026-09-24: an
 * hourly drafting job cleared its backlog on the shared free keys and every
 * reader's question for the rest of the UTC day answered "budget used up". A
 * background job must never be the reason a person gets a wall.
 *
 * So each class carries two limits, both fractions of the day's capacity:
 *
 *   maxShare  — the most this class may spend today, in total;
 *   stopBelow — it may not spend if doing so would leave less than this
 *               fraction of the day unspent (by ANY class). That floor is the
 *               reserve the interactive class draws on.
 *
 * A class with neither (the interactive default) is limited only by capacity
 * itself — the priority class. Pure: the caller owns the spend ledger, this
 * owns the rule, so it is tested with plain numbers.
 *
 * The ledger can only see this app's own spend. When the same keys serve other
 * apps (they do, on the bitbaum box), the vendor's daily 429 is the truth; a
 * background caller should ALSO stop on its first daily refusal.
 */

export interface ClassPolicy {
  /** Fraction (0..1) of the day's capacity this class may spend in total. */
  maxShare?: number;
  /** Fraction (0..1) of the day's capacity that must stay unspent after this call. */
  stopBelow?: number;
}

/** A sensible default: background gets at most a quarter, and never the last half. */
export const BACKGROUND_POLICY: ClassPolicy = { maxShare: 0.25, stopBelow: 0.5 };

export type ClassReason = "ok" | "class-cap" | "reserved" | "no-capacity";

export interface ClassDecision {
  allowed: boolean;
  reason: ClassReason;
  /** Tokens this class may still spend today under its own cap and the floor. */
  roomTokens: number;
  /** Tokens left in the day for everyone, before this call. */
  remainingTokens: number;
}

function frac(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

/**
 * May a call of class `cls` costing `costTokens` go ahead?
 *
 * `spent` is today's spend per class (any class ids; absent = 0).
 */
export function classBudget(input: {
  dayCapacityTokens: number;
  spent: Record<string, number>;
  cls: string;
  costTokens: number;
  policy: Record<string, ClassPolicy>;
}): ClassDecision {
  const capacity = Math.max(0, input.dayCapacityTokens);
  const total = Object.values(input.spent).reduce((a, b) => a + Math.max(0, b || 0), 0);
  const mine = Math.max(0, input.spent[input.cls] ?? 0);
  const cost = Math.max(0, input.costTokens);
  const remainingTokens = Math.max(0, capacity - total);
  if (capacity <= 0 || remainingTokens <= 0)
    return { allowed: false, reason: "no-capacity", roomTokens: 0, remainingTokens };

  const p = input.policy[input.cls] ?? {};
  const cap = frac(p.maxShare);
  const floor = frac(p.stopBelow);
  const byCap = cap === undefined ? Infinity : cap * capacity - mine;
  const byFloor = floor === undefined ? Infinity : remainingTokens - floor * capacity;
  const roomTokens = Math.max(0, Math.min(remainingTokens, byCap, byFloor));

  if (cost > remainingTokens)
    return { allowed: false, reason: "no-capacity", roomTokens, remainingTokens };
  if (cost > byCap) return { allowed: false, reason: "class-cap", roomTokens, remainingTokens };
  if (cost > byFloor) return { allowed: false, reason: "reserved", roomTokens, remainingTokens };
  return { allowed: true, reason: "ok", roomTokens, remainingTokens };
}

/**
 * A rough token count for accounting when the vendor reports none (a stream):
 * ~4 characters a token for English. An estimate, and named as one.
 */
export function estimateTokens(...texts: (string | undefined)[]): number {
  return Math.ceil(texts.reduce((n, t) => n + (t?.length ?? 0), 0) / 4);
}
