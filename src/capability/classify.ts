/**
 * Reading a real response for what it proves about capability.
 *
 * The whole design rests on one asymmetry:
 *
 *   A POSITIVE is cheap. One response carrying `tool_calls` proves, beyond
 *   argument, that this model on this provider with this key can call tools.
 *   Write it down immediately.
 *
 *   A NEGATIVE is expensive and sticky. If a 400 gets recorded as "this model
 *   has no tools", that model is crippled until the record expires — and the
 *   user sees a capable model behaving like a toy with nothing explaining why.
 *   So a negative requires the vendor to SAY it is about tools. A 400 for a
 *   context-length overflow, a malformed parameter, a content filter or a
 *   billing problem proves nothing about tools and must be recorded as
 *   nothing at all.
 *
 * That asymmetry is why `record: false` exists. Most failures are
 * uninformative, and the correct response to an uninformative failure is to
 * learn nothing, not to guess.
 */
import type { Classification } from "./types.js";

/**
 * Phrases that mean "this model does not do tools", conservatively.
 *
 * Every entry names tools or functions explicitly. Deliberately absent:
 * "invalid request", "bad parameter", "unsupported" on its own — each of those
 * appears in vendor 400s for a dozen unrelated reasons, and a match on one of
 * them would silently disable a working model. When in doubt the answer is to
 * record nothing; an unobserved model gets asked again on the next message,
 * whereas a wrongly-negative one does not.
 */
const TOOLS_UNSUPPORTED_PATTERNS: RegExp[] = [
  /tool[\s_-]?(use|call|calls|calling)\s+(is\s+)?(not|un)[\s_-]?support/i,
  /does\s+not\s+support\s+tool/i,
  /doesn'?t\s+support\s+tool/i,
  /no\s+support\s+for\s+tool/i,
  /function[\s_-]?call(ing)?\s+(is\s+)?(not|un)[\s_-]?support/i,
  /does\s+not\s+support\s+function/i,
  /doesn'?t\s+support\s+function/i,
  /model\s+.{0,60}?\s+does\s+not\s+support\s+(the\s+)?(`?tools`?|`?functions`?)/i,
  /unsupported\s+parameter:?\s*'?"?tools?"?'?/i,
  /unknown\s+(field|parameter):?\s*'?"?tools?"?'?/i,
  /`?tools`?\s+is\s+not\s+(a\s+)?(valid|supported|allowed)/i,
];

/**
 * Does this error body explicitly say the model cannot do tools?
 *
 * Conservative on purpose — see the header. A false positive here is a model
 * permanently downgraded for a reason nobody can see; a false negative just
 * means we ask again next time, which costs one request.
 */
export function saysToolsUnsupported(body: string): boolean {
  if (!body) return false;
  return TOOLS_UNSUPPORTED_PATTERNS.some((re) => re.test(body));
}

/** Shape of an OpenAI-compatible chat completion, as far as we care. */
type ChatBody = {
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; tool_calls?: unknown };
  }>;
};

export type ToolAttempt = {
  /** HTTP status. 0 or undefined for a transport failure. */
  status?: number;
  /** Parsed JSON body, when there was one. */
  parsed?: unknown;
  /** Raw body text. Used only for error classification. */
  bodyText?: string;
  /**
   * Did the caller's own text-protocol parser find a usable tool call in the
   * assistant's prose? Only the app knows its envelope, so it answers this.
   * Absent means "not checked", which is not the same as "no".
   */
  textProtocolFound?: boolean;
};

/**
 * What does this attempt prove?
 *
 * Call it after EVERY request that carried tool definitions. Real traffic then
 * classifies every model a user brings, on its first message, at no extra cost
 * — which is the property that makes this scale to models nobody has heard of.
 */
export function classifyToolAttempt(attempt: ToolAttempt): Classification {
  const { status, parsed, bodyText = "", textProtocolFound } = attempt;

  // ── transport failures prove nothing ────────────────────────────────────
  if (!status) {
    return { verdict: "unobserved", record: false, evidence: "no response" };
  }

  // ── the vendor refused, and we must be careful about why ────────────────
  if (status >= 400) {
    if (saysToolsUnsupported(bodyText)) {
      return {
        verdict: "none",
        record: true,
        evidence: `${status}: the vendor says this model does not support tools`,
      };
    }
    // Everything else — 429, 401, 500, a 400 about context length or a bad
    // parameter — says nothing about tools. Learning nothing is correct.
    return {
      verdict: "unobserved",
      record: false,
      evidence: `${status}: not a statement about tool support`,
    };
  }

  // ── a success: did it actually call a tool? ─────────────────────────────
  const body = (parsed ?? {}) as ChatBody;
  const choice = body.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return { verdict: "native", record: true, evidence: "returned tool_calls" };
  }
  if (choice?.finish_reason === "tool_calls") {
    return { verdict: "native", record: true, evidence: "finish_reason was tool_calls" };
  }

  // The app's own envelope parser found a call in the prose. That is the text
  // protocol, and it is a real capability — five of nine free models probed in
  // this fleet answer only this way.
  if (textProtocolFound === true) {
    return {
      verdict: "text",
      record: true,
      evidence: "no tool_calls, but a tool call was parsed from the text",
    };
  }

  // A successful answer with no tool call is the ambiguous case, and the
  // ambiguity is real: the model may be incapable, or it may simply have
  // decided no tool was needed — which is the correct behaviour for most
  // messages. Treating this as evidence of incapacity would mark almost every
  // model `none` within a few turns of ordinary chat.
  return {
    verdict: "unobserved",
    record: false,
    evidence: "answered without calling a tool, which is not evidence either way",
  };
}
