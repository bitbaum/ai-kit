/**
 * How to ask a link for its SHORTEST hidden reasoning — a table, because the
 * parameter is not portable.
 *
 * The default chain leads with reasoning models, and a reasoning model streams
 * nothing a reader can see while it thinks. Measured on the box 2026-09-25,
 * same ~3k-token prompt, groq/openai/gpt-oss-120b:
 *
 *     default effort   first content 649 ms   673 reasoning chars
 *     "low"            first content 205 ms    32 reasoning chars
 *
 * Only settings that were PROBED are listed. The same field is not safe to
 * send everywhere: Groq's Qwen3 ids take `reasoning_effort` only as
 * "none"/"default" and 400 on "low", which would demote a working link.
 * OpenRouter's `reasoning.effort` was probed on
 * nvidia/nemotron-3.5-lightning:free and changed nothing (first content
 * 11.1 s default, 12.4 s "low"), so it is not sent.
 */
import type { Link } from "./chain.js";

const LIGHT: { provider: string; model: RegExp; body: Record<string, unknown> }[] = [
  { provider: "groq", model: /^openai\/gpt-oss-/, body: { reasoning_effort: "low" } },
];

/** Body fields asking this link for light reasoning, or none when it has no probed setting. */
export function reasoningBody(link: Link, level: "light" | undefined): Record<string, unknown> {
  if (level !== "light") return {};
  const row = LIGHT.find((r) => r.provider === link.provider.id && r.model.test(link.model));
  return row ? { ...row.body } : {};
}
