/**
 * Who may spend what, and what to offer when they may not.
 *
 * Pure by the same rule as `fair-share`: no database, no clock, no provider.
 * The caller owns "what has this user done"; this file owns "what are they
 * entitled to, and what should they be shown next".
 *
 * ── WHY THIS IS ONE OBJECT AND NOT TWO ───────────────────────────────────────
 *
 * Across this fleet the same feature was built twice, half each. One app
 * enforces a daily budget with no interface at all — the user is refused and
 * never learns why, or what their share was. Another shows a quota meter with
 * its own separate notion of tier, which the enforcement path does not read.
 * Both are correct in isolation and they cannot agree, because there was no
 * single statement of the policy for them to agree ABOUT.
 *
 * So the policy is data, and the same object answers both questions: the gate
 * asks `decide()` whether to allow, and the settings page asks `decide()` what
 * to draw. A number on screen that the gate does not use is decoration; a gate
 * whose reasoning cannot be rendered is a wall.
 *
 * ── WHY FREE CAPACITY IS A LADDER AND NOT A LIMIT ────────────────────────────
 *
 * Shared free capacity is a fixed cost carried on behalf of strangers, and its
 * only job is to be good enough, once, that someone wants more of it. The
 * moment it runs out is therefore the only moment anybody changes anything —
 * which makes the refusal the most important screen in the product, not an
 * error state.
 *
 * Hence `Wall`: a refusal always carries the ways out, in order, and the
 * default order puts the exits that cost the user NOTHING ahead of the one that
 * costs money. Asking someone to make a free account elsewhere converts far
 * better than asking them to pay, and it removes them from the shared pool just
 * as completely.
 *
 * And there is always a floor. `wait` is a real rung with a real time on it,
 * because "come back at 01:00" is a path and "rate limit exceeded" is a dead
 * end that reads as broken.
 */

/** Where the capacity for a turn comes from. */
export type PoolId =
  /** Your keys, your cost, shared by everyone. The sample. */
  | "platform"
  /** The user's own key. Free to you, uncapped for them. */
  | "user"
  /** A model on the user's machine. Free to everyone. */
  | "local";

/** The ways off the shared pool, and the floor beneath them. */
export type RungId = "byok" | "local" | "earn" | "paid" | "wait";

export interface TierPolicy {
  /** Turns per UTC day. `null` means uncapped — the user is not your cost. */
  turnsPerDay: number | null;
  pool: PoolId;
  /** Present when spending is metered against a balance rather than a count. */
  meter?: "credits";
}

export interface AiPolicy {
  /** Tier id → what it may do. App-defined; only the shape is fixed here. */
  tiers: Record<string, TierPolicy>;
  /**
   * What to offer at a wall, in order.
   *
   * Defaults to free exits first. Overriding it to lead with `paid` is a
   * product decision this package will not make for you, but it is worth
   * knowing you are then asking for money from someone who has not yet
   * finished evaluating the thing.
   */
  ladder?: RungId[];
}

/** Sensible order: everything that costs the user nothing, then money, then the floor. */
export const DEFAULT_LADDER: RungId[] = ["byok", "local", "earn", "paid", "wait"];

/** What the caller knows about this user right now. */
export interface UserState {
  /** Which tier they are on — a key of `policy.tiers`. */
  tier: string;
  /** Turns already spent this UTC day. */
  spentToday: number;
  /** Credit balance, when the tier meters credits. */
  credits?: number;
  /** Rungs this user could actually take. A rung they cannot reach is not offered. */
  available?: Partial<Record<RungId, boolean>>;
}

/** One way out of a wall, ready to render. */
export interface WallOption {
  rung: RungId;
  /** Whether this user can actually take it. */
  available: boolean;
}

/** Everything needed to draw a refusal that is not a dead end. */
export interface Wall {
  reason: "day-spent" | "no-credits" | "unknown-tier";
  /** Ordered, best first. Never empty — `wait` is always last. */
  options: WallOption[];
  /** Epoch ms when the allowance refills, when the caller supplied a day boundary. */
  resetAt: number | null;
}

export interface Decision {
  allowed: boolean;
  /** The resolved tier policy, or null when the tier is not in the policy. */
  policy: TierPolicy | null;
  pool: PoolId | null;
  /**
   * Turns left today. `null` means uncapped, which is NOT the same as zero and
   * must not render as a gauge — there is nothing to draw a level against.
   */
  remaining: number | null;
  /** Present only when `allowed` is false. */
  wall?: Wall;
}

/** Next UTC midnight — when a per-day allowance refills. */
export function nextUtcReset(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function buildWall(reason: Wall["reason"], policy: AiPolicy, state: UserState, now: number): Wall {
  const order = policy.ladder ?? DEFAULT_LADDER;
  const options: WallOption[] = order
    // `wait` is appended below so it can never be configured away.
    .filter((rung) => rung !== "wait")
    .map((rung) => ({ rung, available: state.available?.[rung] ?? true }));

  // The floor. A refusal without a way forward reads as a broken product, and
  // the honest way forward is always "this refills, here is when".
  options.push({ rung: "wait", available: true });

  return { reason, options, resetAt: nextUtcReset(now) };
}

/**
 * May this user spend a turn, and if not, what should they be offered?
 *
 * The same call answers the gate and the settings page. A caller that only
 * needs the number reads `remaining`; one drawing a refusal reads `wall`.
 */
export function decide(policy: AiPolicy, state: UserState, now = Date.now()): Decision {
  const tier = policy.tiers[state.tier];

  // An unknown tier is not a licence to spend. It is a configuration error, and
  // failing closed here is the difference between a typo costing nothing and a
  // typo handing out the shared pool.
  if (!tier) {
    return {
      allowed: false,
      policy: null,
      pool: null,
      remaining: 0,
      wall: buildWall("unknown-tier", policy, state, now),
    };
  }

  if (tier.meter === "credits") {
    const credits = state.credits ?? 0;
    return credits > 0
      ? { allowed: true, policy: tier, pool: tier.pool, remaining: null }
      : {
          allowed: false,
          policy: tier,
          pool: tier.pool,
          remaining: 0,
          wall: buildWall("no-credits", policy, state, now),
        };
  }

  // Uncapped: the user is not your cost, so there is no number to police.
  if (tier.turnsPerDay === null) {
    return { allowed: true, policy: tier, pool: tier.pool, remaining: null };
  }

  const remaining = Math.max(0, tier.turnsPerDay - state.spentToday);
  return remaining > 0
    ? { allowed: true, policy: tier, pool: tier.pool, remaining }
    : {
        allowed: false,
        policy: tier,
        pool: tier.pool,
        remaining: 0,
        wall: buildWall("day-spent", policy, state, now),
      };
}

/**
 * Should the remaining count be put in front of the user yet?
 *
 * A permanent gauge at 96% trains people to ignore the one at 4%. The indicator
 * earns attention near the edge and stays quiet before it — so this returns
 * false for an uncapped tier (nothing to say) and for a user who has barely
 * started.
 */
export function shouldSurface(decision: Decision, threshold = 0.34): boolean {
  if (decision.remaining === null) return false;
  if (!decision.allowed) return true;
  const cap = decision.policy?.turnsPerDay;
  if (!cap) return false;
  return decision.remaining / cap <= threshold;
}
