/**
 * Stop paying for a link that already said no.
 *
 * A free chain walked per request re-asks every link from the top. When the
 * first four have spent their day, every question pays four round trips of
 * 429 before reaching one that answers — measured on substrata 2026-09-24:
 * several seconds per turn, and a tool loop takes several turns. The refusal
 * already says how long it lasts, so remember it and skip the link until
 * then.
 *
 * The refusal's OWN wait wins, daily ones included. Groq's "per day" pools are
 * ROLLING 24-hour windows, not UTC days, and the body names when this one
 * frees ("try again in 3m12s"). Measured 2026-09-25: gpt-oss-20b refused
 * "tokens per day (TPD)" at 00:14 UTC and served normally at 00:17 — while a
 * cooldown to the next UTC midnight kept that link (and gpt-oss-120b, the
 * fastest in the chain) out of substrata's Ask for most of a day, sending every
 * question to a 10-second OpenRouter link. Midnight is only the fallback for a
 * daily refusal that names no wait.
 *
 * Process-local on purpose: it is a latency cache, not a quota ledger. A
 * restart forgets it, and the worst case is one wasted request per link.
 *
 *     const cooldown = createLinkCooldown();          // once per process
 *     completeStream({ chain: cooldown.filter(chain), onLinkFailure: cooldown.record, … })
 */
import type { Link } from "./chain.js";
import { LinkFailure, linkId } from "./complete.js";
import { nextUtcReset } from "./policy.js";

export interface LinkCooldown {
  /** Pass as `onLinkFailure`. Only rate-limit refusals cool a link down. */
  record: (link: Link, error: Error) => void;
  /**
   * The chain without cooled links — or, if that would leave nothing, the
   * whole chain: a stale memory must never be the reason nothing is tried.
   */
  filter: (chain: Link[]) => Link[];
  /** Links cooling now, with when they come back (epoch ms). */
  cooling: () => { link: string; until: number }[];
}

export function createLinkCooldown(
  opts: { now?: () => number; minuteMs?: number } = {},
): LinkCooldown {
  const now = opts.now ?? Date.now;
  const minuteMs = opts.minuteMs ?? 60_000;
  const until = new Map<string, number>();
  return {
    record(link, error) {
      if (!(error instanceof LinkFailure)) return;
      const t = now();
      // A 404 from /chat/completions is a model the vendor no longer serves.
      // Rot is not fixed in minutes, and until the id leaves the chain every
      // turn would pay the round trip; an hour keeps a mistaken 404 cheap.
      if (error.status === 404) {
        until.set(linkId(link), t + 60 * minuteMs);
        return;
      }
      // A "size" 429 is about THIS request's length, not the link: a shorter
      // one may pass a moment later, so it cools nothing.
      if (error.status !== 429 || error.kind === "size") return;
      const named = error.retryAfter && error.retryAfter > 0 ? error.retryAfter * 1000 : null;
      const back =
        named !== null ? t + named : error.kind === "daily" ? nextUtcReset(t) : t + minuteMs;
      until.set(linkId(link), back);
    },
    filter(chain) {
      const t = now();
      const open = chain.filter((l) => (until.get(linkId(l)) ?? 0) <= t);
      return open.length > 0 ? open : chain;
    },
    cooling() {
      const t = now();
      return [...until.entries()].filter(([, u]) => u > t).map(([link, u]) => ({ link, until: u }));
    },
  };
}
