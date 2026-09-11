/**
 * ai-kit/capability — what a model can do, observed rather than declared.
 *
 * Replaces the list every app writes and every app gets wrong:
 *
 *   const TOOL_CAPABLE_PROVIDERS = ['groq', 'openrouter'];
 *
 * That line is wrong the moment a user brings a model nobody on the team has
 * heard of, which is every day. It is also wrong in the other direction: it
 * cannot express that five of nine free models answer tools only in prose, so
 * a native-only client silently loses most of its chain while believing it is
 * fine.
 *
 * The replacement is not a better list. It is three rules:
 *
 *   1. The first real call IS the probe. Send tools, read what comes back,
 *      write down what it proved. Every model a user brings classifies itself
 *      on its first message, at no extra cost and with no release from us.
 *   2. A positive is cheap and a negative is expensive. One `tool_calls`
 *      proves capability. A 400 proves nothing unless the vendor SAYS it is
 *      about tools — otherwise a context-length overflow permanently cripples
 *      a capable model and nothing explains why.
 *   3. "Never asked" is its own answer. Optimistic on the wire, because asking
 *      is how we learn; pessimistic in the prompt and the UI, because
 *      announcing an unproven capability is a promise the model may not keep.
 *
 * Storage stays with the app — a table, a KV, a file. This package owns the
 * shape and the rules, which is the part everyone gets wrong; it does not own
 * where rows live, which is the part where apps legitimately differ.
 */
export type {
  ToolVerdict,
  CapabilityKind,
  Provenance,
  CapabilityRecord,
  CapabilityStore,
  Classification,
} from "./types.js";

export { classifyToolAttempt, saysToolsUnsupported, type ToolAttempt } from "./classify.js";

export {
  planToolAttempt,
  claimableVerdict,
  currentVerdict,
  isStale,
  makeRecord,
  scopeKey,
  shouldReplace,
  DEFAULT_TTL_MS,
  type ToolPlan,
} from "./decide.js";
