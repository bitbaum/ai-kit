/**
 * The other way models ask for a tool: by writing it in the reply.
 *
 * ── WHY A NATIVE-ONLY CLIENT LOSES MOST OF THIS PACKAGE'S OWN CHAIN ──────────
 *
 * `chain.ts` carries a probe table from nine free models called with a real
 * tool. Four answered with native `tool_calls`. Five answered only in TEXT.
 * Of the seven models in the shipped default chain today, three are in that
 * second group:
 *
 *   google/gemma-4-26b-a4b-it:free      text
 *   cohere/north-mini-code:free         text
 *   openrouter/free                     text
 *
 * A client that reads only `message.tool_calls` gets ZERO tool calls from those
 * three — and, far worse, gets the model's narration of the call as ordinary
 * content. So a turn that should have looked up a record instead returns a
 * confident sentence describing the lookup it did not perform, and every layer
 * downstream treats it as an answer. That is not a missing feature; it is a
 * fabrication path, and it is open on nearly half the chain this package ships.
 *
 * ── WHY LINE-BASED AND NOT NESTED JSON ───────────────────────────────────────
 *
 * The format is chosen for the WEAKEST model expected to run it, not the
 * strongest. An 8B model reliably reproduces two flat lines:
 *
 *     TOOL: search_people
 *     ARGS: {"query": "Elena"}
 *
 * The same model routinely breaks nested-JSON escaping. Every leniency in the
 * parser below is a shape a small model actually emitted in production — bolded
 * keys because it was writing markdown, a fenced ARGS block, the parentheses
 * copied from the example, a missing ARGS line for a no-argument tool. Rejecting
 * any of them would fail the turn over formatting, which is the exact failure
 * this protocol exists to avoid.
 */

/** The tool-call shape, matching `complete`'s. `args` stays a raw JSON string. */
export interface ParsedToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * The convention, as prompt text.
 *
 * Exported so apps stop writing their own wording and drifting from the parser
 * that has to read it back. A prompt and its parser are one contract; keeping
 * them in separate repos is how they diverge.
 *
 * Note what it does NOT say: it never tells the model to use this INSTEAD of
 * native calling. A model with native support should use it, and this is the
 * fallback for one that cannot — offering both costs a few tokens and covers
 * both halves of the chain.
 */
export const TEXT_TOOL_PROTOCOL_HINT = [
  "If you cannot emit a native tool call, call a tool by writing these two lines in your reply, exactly like this:",
  "",
  "TOOL: tool_name",
  'ARGS: {"argument": "value"}',
  "",
  "Write nothing else in a reply that calls tools — you will be given the results and asked again.",
].join("\n");

/** Matches a TOOL: line, tolerating list bullets, markdown bold, and `=`. */
const TOOL_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?TOOL(?:\*\*)?\s*[:=]\s*(.+?)\s*$/i;
/** Matches an ARGS: line, same tolerances. */
const ARGS_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?ARGS(?:\*\*)?\s*[:=]\s*(.*)$/i;
/** Either key, for the strip pass. */
const EITHER_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?(?:TOOL|ARGS)(?:\*\*)?\s*[:=]/i;

/** How far past a TOOL: line to look for its ARGS:, and how far to join a multi-line object. */
const ARGS_SEARCH_LINES = 4;
const ARGS_JOIN_LINES = 8;

/**
 * Parse a JSON object, tolerating fences and trailing prose. Null if hopeless.
 *
 * `null` and `{}` must stay distinguishable. Returning `{}` for "nothing
 * parseable here" satisfies a caller's `?? {}` fallback and silently discards
 * arguments the model put on the NEXT line — which is exactly what a model does
 * when it opens a ```json fence after `ARGS:`. That cost a debugging cycle once
 * already; it is a test here now.
 */
export function safeJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  if (!cleaned) return null;
  if (cleaned === "{}") return {};

  const start = cleaned.indexOf("{");
  if (start === -1) return null;

  // Walk to the matching brace so trailing commentary does not break the parse.
  // String-aware: a brace inside a quoted value must not change the depth, or
  // an argument like {"q": "a } b"} truncates at the wrong place.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(cleaned.slice(start, i + 1));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Extract text-protocol calls from a reply.
 *
 * `validNames` is the closed set the model was offered. A line naming anything
 * else is left alone: without that check, a model writing the words "TOOL:
 * whatever" in prose would manufacture a call to a tool that does not exist,
 * and the executor would report a failure the model never asked for.
 */
export function parseTextToolCalls(text: string, validNames: string[]): ParsedToolCall[] {
  if (!text || validNames.length === 0) return [];
  const calls: ParsedToolCall[] = [];
  const valid = new Set(validNames);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = TOOL_LINE.exec(line);
    const rawName = m?.[1];
    if (!rawName) continue;

    // Tolerate `name(...)`, backticks, and trailing punctuation copied from prose.
    const name = rawName
      .replace(/[`*]/g, "")
      .replace(/\(.*$/, "")
      .replace(/[.,;]$/, "")
      .trim();
    if (!valid.has(name)) continue;

    let args = "{}";
    for (let j = i + 1; j < Math.min(i + ARGS_SEARCH_LINES, lines.length); j++) {
      const next = lines[j] ?? "";
      const a = ARGS_LINE.exec(next);
      if (a) {
        // The object may continue past this line: a model opening a ```json
        // fence puts the brace on the NEXT line, and a pretty-printed object
        // spans several. Join forward and let the brace matcher find the end.
        const rest = lines.slice(j, Math.min(j + ARGS_JOIN_LINES, lines.length)).join("\n");
        const parsed =
          safeJsonObject(a[1] ?? "") ?? safeJsonObject(rest.replace(/^[^:=]*[:=]/, ""));
        if (parsed) args = JSON.stringify(parsed);
        break;
      }
      // A new TOOL line means this call simply had no arguments.
      if (TOOL_LINE.test(next)) break;
    }

    calls.push({ id: `text_${calls.length}_${name}`, name, args });
  }
  return calls;
}

/**
 * Remove protocol lines from prose.
 *
 * A narrated call must never reach the user as though it were an answer, which
 * is the whole failure this module exists to close. Stripping also means a reply
 * that was ONLY a tool call ends up empty — and an empty reply carrying tool
 * calls is a valid turn, while an empty reply carrying none is an outage. The
 * caller has to keep those apart.
 */
export function stripToolCallLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !EITHER_LINE.test(l))
    .join("\n")
    .replace(/```(?:json)?\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The tool names inside an OpenAI-shaped `tools` array.
 *
 * Derived from what the caller already passed rather than asked for separately:
 * two lists that must agree are one list that cannot disagree, and the failure
 * of the split version is silent — a name missing from the second list makes
 * the parser ignore a real call.
 */
export function toolNamesFrom(tools: unknown[] | undefined): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const entry of tools) {
    const fn = (entry as { function?: { name?: unknown } } | null)?.function;
    if (fn && typeof fn.name === "string" && fn.name) names.push(fn.name);
  }
  return names;
}
