/**
 * The grounding harness — imported, no longer mirrored.
 *
 * These three modules were born in FleetCrown (`src/lib/agent/core/`) and
 * lived as a byte-identical mirror in OrangeCat, guarded by a SHA-256 drift
 * check, because both assistants had the same failure: a model asked to fill
 * a rigid answer format against thin context invents the missing parts, and
 * the invention is indistinguishable from truth because both arrive as
 * confident prose.
 *
 * The mirror's own README called the duplication "deliberate and temporary"
 * and named this extraction as the exit. This is that exit: both apps now
 * import `ai-kit/grounding`, and the drift check retires — two
 * silently-diverging definitions of "what counts as grounded" are no longer
 * possible, because there is only one.
 *
 * The constraint that made the code mirrorable is the constraint that makes
 * it packageable, and it still holds: pure TypeScript, no DB, no network, no
 * framework, no imports outside this directory. Anything that knows where
 * data lives belongs in the app adapter that maps rows to `Fact`s, not here.
 */
export {
  NOT_RECORDED,
  FACT_KINDS,
  declaredFields,
  makeFact,
  assignFactIds,
  factIds,
  renderFacts,
  unrecordedFields,
  type Fact,
} from "./facts.js";

export {
  NO_BASIS,
  buildContract,
  buildAssistantRules,
  directiveId,
  renderDirectives,
  buildGroundedContext,
  type Directive,
} from "./contract.js";

export {
  verifyAnswer,
  buildRepairPrompt,
  type Violation,
  type VerifyResult,
  type VerifyMode,
} from "./verify.js";
