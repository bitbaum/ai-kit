"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRepairPrompt = exports.verifyAnswer = exports.buildGroundedContext = exports.renderDirectives = exports.directiveId = exports.buildAssistantRules = exports.buildContract = exports.NO_BASIS = exports.unrecordedFields = exports.renderFacts = exports.factIds = exports.assignFactIds = exports.makeFact = exports.declaredFields = exports.FACT_KINDS = exports.NOT_RECORDED = void 0;
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
var facts_js_1 = require("./facts.js");
Object.defineProperty(exports, "NOT_RECORDED", { enumerable: true, get: function () { return facts_js_1.NOT_RECORDED; } });
Object.defineProperty(exports, "FACT_KINDS", { enumerable: true, get: function () { return facts_js_1.FACT_KINDS; } });
Object.defineProperty(exports, "declaredFields", { enumerable: true, get: function () { return facts_js_1.declaredFields; } });
Object.defineProperty(exports, "makeFact", { enumerable: true, get: function () { return facts_js_1.makeFact; } });
Object.defineProperty(exports, "assignFactIds", { enumerable: true, get: function () { return facts_js_1.assignFactIds; } });
Object.defineProperty(exports, "factIds", { enumerable: true, get: function () { return facts_js_1.factIds; } });
Object.defineProperty(exports, "renderFacts", { enumerable: true, get: function () { return facts_js_1.renderFacts; } });
Object.defineProperty(exports, "unrecordedFields", { enumerable: true, get: function () { return facts_js_1.unrecordedFields; } });
var contract_js_1 = require("./contract.js");
Object.defineProperty(exports, "NO_BASIS", { enumerable: true, get: function () { return contract_js_1.NO_BASIS; } });
Object.defineProperty(exports, "buildContract", { enumerable: true, get: function () { return contract_js_1.buildContract; } });
Object.defineProperty(exports, "buildAssistantRules", { enumerable: true, get: function () { return contract_js_1.buildAssistantRules; } });
Object.defineProperty(exports, "directiveId", { enumerable: true, get: function () { return contract_js_1.directiveId; } });
Object.defineProperty(exports, "renderDirectives", { enumerable: true, get: function () { return contract_js_1.renderDirectives; } });
Object.defineProperty(exports, "buildGroundedContext", { enumerable: true, get: function () { return contract_js_1.buildGroundedContext; } });
var verify_js_1 = require("./verify.js");
Object.defineProperty(exports, "verifyAnswer", { enumerable: true, get: function () { return verify_js_1.verifyAnswer; } });
Object.defineProperty(exports, "buildRepairPrompt", { enumerable: true, get: function () { return verify_js_1.buildRepairPrompt; } });
