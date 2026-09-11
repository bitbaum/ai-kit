/**
 * What to send this time, and what to tell the user we can do.
 *
 * Two different questions, deliberately separated:
 *
 *   `planToolAttempt` decides what to PUT ON THE WIRE. It is optimistic about
 *   an unobserved model, because the only way to learn is to ask, and the cost
 *   of asking is one request that may ignore the tools.
 *
 *   `claimableVerdict` decides what to SAY. It is pessimistic about an
 *   unobserved model, because promising a capability we have never seen is how
 *   an assistant comes to announce an action it cannot perform.
 *
 * Those two pulling in opposite directions is the whole point. A single
 * "supportsTools" boolean cannot express it, and every app that has tried has
 * either refused to learn or lied to its users.
 */
import { createHash } from "node:crypto";
import type { CapabilityKind, CapabilityRecord, ToolVerdict } from "./types.js";

/**
 * How long an observation stands before it must be re-earned.
 *
 * Models change under their own names — a vendor updates the weights behind an
 * alias, an org enables a feature, a local user swaps a quantization. A record
 * with no expiry is a hardcoded list again, just one we wrote ourselves.
 *
 * Negatives expire sooner than positives: a model that gained tool support and
 * is still marked `none` is invisibly crippled, while a model that lost it
 * announces itself loudly on the next call.
 */
export const DEFAULT_TTL_MS = {
  native: 30 * 24 * 60 * 60 * 1000,
  text: 30 * 24 * 60 * 60 * 1000,
  none: 7 * 24 * 60 * 60 * 1000,
  unobserved: 0,
} as const;

export function isStale(
  record: Pick<CapabilityRecord, "verdict" | "observedAt">,
  now: Date = new Date(),
  ttl: Partial<Record<ToolVerdict, number>> = {},
): boolean {
  const limit = ttl[record.verdict] ?? DEFAULT_TTL_MS[record.verdict];
  if (!limit) return true;
  const age = now.getTime() - new Date(record.observedAt).getTime();
  return !Number.isFinite(age) || age > limit;
}

/** The verdict a record still supports, or `unobserved` once it has expired. */
export function currentVerdict(
  record: CapabilityRecord | null | undefined,
  now: Date = new Date(),
  ttl: Partial<Record<ToolVerdict, number>> = {},
): ToolVerdict {
  if (!record) return "unobserved";
  return isStale(record, now, ttl) ? "unobserved" : record.verdict;
}

export type ToolPlan = {
  /** Put tool definitions on the request? */
  sendTools: boolean;
  /** Parse the prose for a tool envelope as well? */
  expectTextProtocol: boolean;
  /** True when this request is also the thing that will teach us. */
  isLearning: boolean;
  reason: string;
};

/**
 * What to send. Optimistic about the unknown, because asking is how we learn
 * and a declared prior is only a guess about where to start.
 */
export function planToolAttempt(input: {
  observed: ToolVerdict;
  /** What a registry or the vendor's docs claim. A prior, never a fact. */
  declared?: ToolVerdict;
}): ToolPlan {
  const { observed, declared } = input;

  if (observed === "native") {
    return {
      sendTools: true,
      expectTextProtocol: false,
      isLearning: false,
      reason: "observed to return tool_calls",
    };
  }
  if (observed === "text") {
    return {
      sendTools: false,
      expectTextProtocol: true,
      isLearning: false,
      reason: "observed to answer tools only in prose",
    };
  }
  if (observed === "none") {
    return {
      sendTools: false,
      expectTextProtocol: false,
      isLearning: false,
      reason: "the vendor said this model does not support tools",
    };
  }

  // Unobserved. Ask — and accept EITHER answer, because a model that ignores
  // the definitions and writes the envelope in prose is capable, just not
  // natively, and a native-only client silently loses most of a free chain.
  return {
    sendTools: declared !== "none",
    expectTextProtocol: true,
    isLearning: true,
    reason:
      declared === "none"
        ? "never observed, and the registry says no — asking in prose only"
        : "never observed — this request is also the probe",
  };
}

/**
 * What we may TELL the user, and what the prompt may claim.
 *
 * Pessimistic about the unknown. `unobserved` returns `none` here on purpose:
 * until a model has demonstrated a capability, an assistant that announces it
 * is writing a cheque the model may not honour, and the user discovers that as
 * a broken promise rather than as a missing feature.
 */
export function claimableVerdict(observed: ToolVerdict): Exclude<ToolVerdict, "unobserved"> {
  return observed === "unobserved" ? "none" : observed;
}

/**
 * A stable, non-reversible handle for the credential an observation was made
 * through. Capability differs per key, so observations must not leak across
 * keys — and the key itself must never be stored to achieve that.
 */
export function scopeKey(secret: string | undefined | null): string {
  if (!secret) return "anonymous";
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/** Build a record from a classification. Keeps `observedAt` in one place. */
export function makeRecord(input: {
  provider: string;
  model: string;
  scope: string;
  capability: CapabilityKind;
  verdict: ToolVerdict;
  via: CapabilityRecord["via"];
  evidence?: string;
  now?: Date;
}): CapabilityRecord {
  return {
    provider: input.provider,
    model: input.model,
    scope: input.scope,
    capability: input.capability,
    verdict: input.verdict,
    via: input.via,
    observedAt: (input.now ?? new Date()).toISOString(),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
}

/**
 * Should a new observation overwrite the stored one?
 *
 * Strength beats age, and `live` beats `declared`, so a real call always
 * overrules a registry guess. Between two observations of equal provenance the
 * newer wins — including a `none` replacing a `native`, because a model really
 * can lose a capability and refusing to believe that is how a chain keeps
 * calling something that no longer works.
 */
export function shouldReplace(
  existing: CapabilityRecord | null | undefined,
  incoming: CapabilityRecord,
): boolean {
  if (!existing) return true;
  const rank = { declared: 0, probe: 1, live: 2 } as const;
  if (rank[incoming.via] > rank[existing.via]) return true;
  if (rank[incoming.via] < rank[existing.via]) return false;
  return new Date(incoming.observedAt).getTime() >= new Date(existing.observedAt).getTime();
}
