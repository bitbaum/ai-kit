/**
 * The call itself — the one thing this package refused to ship, and the reason
 * the rest of it went unused.
 *
 * ── WHY THIS REVERSES A STATED RULE ──────────────────────────────────────────
 * Every module here was written against a real outage, and every one of them is
 * correct. None of that reached the apps that were actually failing. Measured
 * across the fleet on 2026-09-05:
 *
 *   this package's decisions      adopted by 2 repos
 *   `ai-forms`, which ships a working handler        adopted by 5 repos
 *   hand-rolled LLM clients still in service         8, ~1400-1700 lines each
 *
 * The pattern is not about quality, it is about shape. `ai-forms` was adopted
 * because `createFormAssistHandler` does the job; this package was not, because
 * it hands back advice the caller must then wire up. The old rule — "every app
 * has its own calling conventions, replacing them is a rewrite rather than an
 * adoption" — describes the duplication accurately and then protects it. The
 * conventions differ because nothing ever offered to own them.
 *
 * The cost of that is not theoretical. Of the 8 hand-rolled clients, 2 tell the
 * three kinds of 429 apart; the other 6 treat a spent daily budget as a busy
 * minute — `limits.ts` has explained why that is harmful since 2026-08-14, in a
 * module those 6 apps do not import. `tryChain` says it plainly: a chain nobody
 * walks is a list, not a fallback. A decision nobody calls is a comment.
 *
 * So: this owns the fetch. `tryChain` stays for callers with a genuinely
 * unusual request to make; this is the answer for everyone else.
 *
 * ── WHAT IT KNOWS THAT A HAND-ROLLED LOOP DOES NOT ───────────────────────────
 * Walking the chain is the easy half. Three behaviours below are the ones every
 * hand-rolled client in this fleet got wrong, each traced to an incident:
 *
 *   HTTP 200 IS NOT SUCCESS. `nvidia/nemotron-nano-12b-v2-vl` returns 200 with
 *   empty content, and `gemini-2.5-flash` does the same after a tool call — it
 *   spends its whole budget on internal thinking and emits no text part. A
 *   client that checks `res.ok` returns "" to the user and reports success, so
 *   the chain never advances and health stays green through a total outage.
 *   Empty content is a FAILURE here, and it demotes to the next link.
 *
 *   A DAILY 429 CONDEMNS THE WHOLE VENDOR, not one model. The budget is
 *   org-wide and shared across models, so every remaining link at that provider
 *   is already dead. Walking them costs a dead round trip each and reaches the
 *   same failure. They are skipped.
 *
 *   A SIZE 429 ENDS THE WALK. One request exceeded the entire per-minute
 *   allowance; the next model down has a SMALLER ceiling (measured: 12000 TPM
 *   vs 6000), so demoting makes it strictly worse. The only cure is a shorter
 *   prompt, and the caller is told exactly that instead of watching the chain
 *   burn itself down to reach a worse version of the same error.
 *
 * ── AND ONE IT INHERITS ──────────────────────────────────────────────────────
 * The response BODY is kept in every error. A status-only message ("groq 429")
 * makes an exhausted day indistinguishable from a momentary burst, and the
 * obvious remedy for the latter — wait and retry — can never work for the
 * former. That misdiagnosis cost an hour once; it is not free to repeat.
 */

import { type Env, type Link, type Provider, chainFrom, freeChain, usableChain } from "./chain.js";
import { ChainExhaustedError, type ChainAttemptFailure } from "./attempt.js";
import type { HealthTracker } from "./health.js";
import { classifyRateLimit, retryAfterSeconds, type RateLimitKind } from "./limits.js";

/** One message in the OpenAI chat-completions shape every provider here speaks. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on `role: "tool"` replies; passed through untouched. */
  tool_call_id?: string;
  name?: string;
}

/**
 * A tool call the model asked for, normalised across the two protocols models
 * actually answer on.
 *
 * Both exist in the default chain: of nine free models probed live, four
 * answered with native `tool_calls` and five only in text. Callers get the
 * native shape here; parsing the text protocol is the caller's business,
 * because its convention differs per app.
 */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as the model emitted it — NOT parsed, because a model can emit invalid JSON and the caller decides what to do about that. */
  args: string;
}

export interface CompleteOptions {
  messages: ChatMessage[];
  /**
   * Links to try, in order. Defaults to `usableChain(freeChain())` — every free
   * provider that has a key in `env`.
   */
  chain?: Link[];
  /** Providers to derive the chain from when `chain` is not given. */
  providers?: Provider[];
  /**
   * Start the chain at this model rather than the front, falling through to the
   * rest. The usual home for an app's "use this model" env var.
   */
  model?: string;
  env?: Env;
  health?: HealthTracker;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** Tool definitions in the OpenAI shape; passed through untouched. */
  tools?: unknown[];
  /** Extra body fields for a vendor-specific parameter. Merged last, so it can override. */
  extraBody?: Record<string, unknown>;
  /** Called on each link's failure before moving on — e.g. to log which id rotted. */
  onLinkFailure?: (link: Link, error: Error) => void;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface CompleteResult {
  /** The assistant's text. Never empty — an empty completion is treated as a failure. */
  text: string;
  /** `provider/model`, the id worth logging: it says which link actually served the turn. */
  id: string;
  link: Link;
  toolCalls: ToolCall[];
  /** The parsed response body, for a caller that needs a field this does not surface. */
  raw: unknown;
}

/**
 * A link failed in a way that says something about the WALK, not just this link.
 *
 * `kind` is what the walker acts on; it is carried on the error so a caller
 * reading `ChainExhaustedError.failures` can see why the walk stopped where it
 * did rather than inferring it from prose.
 */
export class LinkFailure extends Error {
  readonly link: Link;
  readonly status?: number;
  readonly kind?: RateLimitKind;
  readonly retryAfter?: number | null;

  constructor(
    link: Link,
    message: string,
    init: { status?: number; kind?: RateLimitKind; retryAfter?: number | null } = {},
  ) {
    super(message);
    this.name = "LinkFailure";
    this.link = link;
    this.status = init.status;
    this.kind = init.kind;
    this.retryAfter = init.retryAfter;
  }
}

/** `provider/model` — the id worth logging, because the model alone does not say whose meter it drew on. */
export function linkId(link: Link): string {
  return `${link.provider.id}/${link.model}`;
}

function firstText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  // Some vendors return content as an array of parts. Concatenate the text ones
  // rather than stringifying the array, which would hand the caller JSON.
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

function toolCallsFrom(message: Record<string, unknown> | undefined): ToolCall[] {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const fn = (entry as { function?: { name?: unknown; arguments?: unknown } }).function;
    if (!fn || typeof fn.name !== "string") continue;
    out.push({
      id: String((entry as { id?: unknown }).id ?? ""),
      name: fn.name,
      args: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return out;
}

/**
 * Truncated so a failure message stays readable in a log line, but long enough
 * to carry the sentence that matters: Groq states the real reset ~90 characters
 * into a daily-cap body, and cutting before it throws away the one number the
 * user can act on.
 */
function excerpt(body: string, limit = 300): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

async function callLink(
  link: Link,
  options: CompleteOptions,
  key: string,
): Promise<CompleteResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const body: Record<string, unknown> = {
    model: link.model,
    messages: options.messages,
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...options.extraBody,
  };

  let res: Response;
  try {
    res = await doFetch(`${link.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    // A transport failure (DNS, TLS, abort) is not the vendor's answer, so it
    // carries no rate-limit kind — it demotes like any other link failure.
    throw new LinkFailure(link, `${linkId(link)}: ${(error as Error).message}`);
  }

  const text = await res.text();

  if (!res.ok) {
    if (res.status === 429) {
      const kind = classifyRateLimit(text);
      const retryAfter = retryAfterSeconds(text);
      throw new LinkFailure(link, `${linkId(link)}: 429 ${kind} — ${excerpt(text)}`, {
        status: 429,
        kind,
        retryAfter,
      });
    }
    throw new LinkFailure(link, `${linkId(link)}: ${res.status} — ${excerpt(text)}`, {
      status: res.status,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LinkFailure(link, `${linkId(link)}: 200 with unparseable body — ${excerpt(text)}`, {
      status: res.status,
    });
  }

  const choice = (parsed as { choices?: Array<{ message?: Record<string, unknown> }> })
    ?.choices?.[0];
  const content = firstText(choice?.message);
  const toolCalls = toolCallsFrom(choice?.message);

  // A 200 that carries neither text nor a tool call is an outage wearing a
  // success code — see the header. Demote, so the chain gets its chance.
  if (content.trim() === "" && toolCalls.length === 0) {
    throw new LinkFailure(
      link,
      `${linkId(link)}: 200 with empty content — model produced no output`,
      {
        status: res.status,
      },
    );
  }

  return { text: content, id: linkId(link), link, toolCalls, raw: parsed };
}

/**
 * Call the first link that works, and return what it said.
 *
 * Throws `ChainExhaustedError` carrying every link's failure, so a log shows
 * what was actually tried — the failure that explains an outage is usually not
 * the last one.
 */
export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  const env = options.env ?? process.env;
  const base = options.chain ?? usableChain(options.providers ?? freeChain(), env);
  const chain = chainFrom(options.model, base);

  const failures: ChainAttemptFailure[] = [];
  const deadProviders = new Set<string>();

  for (const link of chain) {
    // A daily cap already condemned this vendor earlier in the walk. Its other
    // models draw on the same exhausted budget, so trying them buys a dead
    // round trip and the identical error.
    if (deadProviders.has(link.provider.id)) continue;

    const key = env[link.provider.keyEnv]?.trim();
    if (!key) {
      failures.push({ link, message: `${linkId(link)}: no ${link.provider.keyEnv} in env` });
      continue;
    }

    try {
      const result = await callLink(link, options, key);
      options.health?.recordSuccess();
      return result;
    } catch (error) {
      const failure = error as LinkFailure;
      failures.push({ link, message: failure.message });
      options.onLinkFailure?.(link, failure);

      if (failure.kind === "daily") deadProviders.add(link.provider.id);

      // Stepping down after a size 429 reaches a model with a smaller ceiling —
      // strictly worse. Stop, and let the caller shorten the prompt.
      if (failure.kind === "size") break;
    }
  }

  const exhausted = new ChainExhaustedError(failures);
  options.health?.recordFailure(exhausted);
  throw exhausted;
}
