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
import { readQuota, readingFromRefusal, type QuotaReading } from "./meter.js";
import { parseTextToolCalls, stripToolCallLines, toolNamesFrom } from "./tool-protocol.js";

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
 * answered with native `tool_calls` and five only in text — and three of the
 * seven models shipped in the chain today are in that second group. Since 1.4.0
 * both are read here, so a caller no longer has to know which half of the chain
 * answered. See `toolProtocol` on CompleteOptions, and tool-protocol.ts for why
 * a native-only read is a fabrication path rather than a missing feature.
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
  /**
   * The CALLER's cancellation, covering the whole walk. When this aborts, the
   * walk stops — the caller has gone, so trying the next vendor on their behalf
   * is work nobody is waiting for.
   *
   * Do not use this as a timeout. See `timeoutMs`.
   */
  signal?: AbortSignal;
  /**
   * How long ONE link may take before it is abandoned and the next is tried.
   * Default 30s. Set 0 to wait forever (not advised).
   *
   * Per LINK, and that is the whole point. A vendor that accepts the connection
   * and then never answers is the most common partial outage there is, and it
   * is the one a fallback chain is least able to survive: without a deadline,
   * `await fetch` simply never returns and link two is never reached. A chain
   * that cannot time out is not a fallback for the failure mode it most needs
   * to cover.
   *
   * It is deliberately NOT the caller's `signal`. A caller who passes a 10s
   * budget as `signal` has the first link spend all of it, and links two
   * onward inherit a signal that is already aborted — so the "fallback" fails
   * instantly and reports every vendor broken when only the first was slow.
   * Handing each link its own budget is the only shape in which a deadline and
   * a fallback can both be true.
   */
  timeoutMs?: number;
  /**
   * Set this GENEROUSLY, or a healthy model looks dead.
   *
   * The default chain leads with reasoning models, which spend this budget
   * thinking before emitting a visible token. Set it too low and the vendor
   * returns 200 with empty content — which this module correctly treats as a
   * failure and demotes, so a small `maxTokens` silently walks the whole chain
   * and reports every link broken. Measured 2026-09-05: groq/openai/gpt-oss-20b
   * answered EMPTY at 16 and answered correctly at 256, for the same one-word
   * question.
   */
  maxTokens?: number;
  temperature?: number;
  /** Tool definitions in the OpenAI shape; passed through untouched. */
  tools?: unknown[];
  /**
   * Which tool-call protocols to READ from the reply. Default `"both"`.
   *
   * `"both"` also parses the `TOOL:` / `ARGS:` line protocol out of ordinary
   * content and strips those lines from `text`. This matters more than it
   * sounds: three of the seven models in the default chain cannot emit a native
   * tool call at all, and a native-only read hands their narration back as a
   * finished answer. The turn then reports a lookup that never happened.
   *
   * Parsing is skipped entirely when no `tools` are supplied — a model does not
   * narrate a call it was never offered — so this is inert for the callers who
   * do not use tools, which today is all of them.
   *
   * Set `"native"` only if you parse the text protocol yourself and would
   * otherwise execute each call twice.
   */
  toolProtocol?: "both" | "native";
  /** Extra body fields for a vendor-specific parameter. Merged last, so it can override. */
  extraBody?: Record<string, unknown>;
  /**
   * Extra request headers. Merged last, so a caller can override `content-type`
   * — but NOT `authorization`, which stays the key this module resolved.
   *
   * Vendors ask for these and quietly change behaviour without them:
   * OpenRouter reads `HTTP-Referer` and `X-Title` for app attribution in its
   * public rankings, and an app that stops sending them simply disappears from
   * that list with no error anywhere. Without this option, adopting `complete`
   * would mean silently dropping them, which is exactly the kind of small,
   * invisible regression that makes a shared engine feel worse than the
   * hand-rolled client it replaced.
   */
  extraHeaders?: Record<string, string>;
  /** Called on each link's failure before moving on — e.g. to log which id rotted. */
  onLinkFailure?: (link: Link, error: Error) => void;
  /**
   * Called with every remaining-quota figure the vendor disclosed, on success
   * AND on refusal. This is how an app learns what is left without spending a
   * request to ask.
   *
   * It fires on 429s too, and those are the most valuable readings of all: a
   * refusal is the vendor correcting a local counter that had drifted
   * optimistic. See `meter.ts` for why polling a vendor's usage endpoint
   * instead is the wrong design — one of them reports an untouched allowance
   * while the key is locked out.
   *
   * Keep it cheap and never let it throw: it runs inside the response path, and
   * an exception here would turn a good answer into a link failure. Persisting
   * is the app's job, which is why this is a callback and not a store — the
   * package stays free of a database.
   */
  onQuota?: (readings: QuotaReading[]) => void;
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

/**
 * Long enough that a slow-but-working reasoning model finishes, short enough
 * that a hung vendor does not hold a request open until something upstream
 * gives up on it.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

interface LinkDeadline {
  signal: AbortSignal | undefined;
  /** True when THIS link's own clock fired, rather than the caller cancelling. */
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  /** Always call. An uncleared timer keeps the event loop alive. */
  dispose(): void;
}

/**
 * One link's deadline, composed with the caller's cancellation.
 *
 * Hand-rolled rather than `AbortSignal.any`, which landed in Node 20.3 — this
 * package supports Node >= 20, and a helper that works on 20.0 costs eight
 * lines while an engines bump costs every consumer a decision.
 */
function linkDeadline(caller: AbortSignal | undefined, timeoutMs: number): LinkDeadline {
  if (timeoutMs <= 0) {
    return { signal: caller, timedOut: false, timeoutMs, dispose() {} };
  }

  const controller = new AbortController();
  const state = { timedOut: false };

  // Deliberately NOT unref'd. It is tempting — a stray timer holding a process
  // open is a real nuisance — but this one is always cleared in `dispose`, so
  // there is nothing to save, and an unref'd timer stops firing whenever
  // nothing else keeps the loop alive. That turns the deadline into a deadline
  // that sometimes does not happen, which is worse than none at all.
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error(`link timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return state.timedOut;
    },
    timeoutMs,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
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

  const deadline = linkDeadline(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await doFetch(`${link.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options.extraHeaders,
        // Last on purpose. A caller may add or override any header it likes,
        // but not this one: silently sending someone else's credential — or
        // none — would turn a typo in a caller's header map into an auth
        // failure blamed on the vendor.
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
  } catch (error) {
    // A transport failure (DNS, TLS, abort) is not the vendor's answer, so it
    // carries no rate-limit kind — it demotes like any other link failure.
    //
    // Name a timeout as a timeout. "The operation was aborted" in a log is
    // indistinguishable from a caller cancelling, and the two want opposite
    // reactions from whoever reads it.
    if (deadline.timedOut) {
      throw new LinkFailure(
        link,
        `${linkId(link)}: no response within ${deadline.timeoutMs}ms — abandoned, trying the next link`,
      );
    }
    throw new LinkFailure(link, `${linkId(link)}: ${(error as Error).message}`);
  } finally {
    deadline.dispose();
  }

  const text = await res.text();

  // Read the tank before interpreting the answer, so a refusal still reports
  // what it disclosed. A caller's hook must never turn a good response into a
  // failure, so it is isolated — an app's logging bug is not a vendor outage.
  const report = (readings: QuotaReading[]) => {
    if (readings.length === 0 || !options.onQuota) return;
    try {
      options.onQuota(readings);
    } catch {
      /* the caller's sink is the caller's problem */
    }
  };
  report(readQuota(res.headers, link));

  if (!res.ok) {
    if (res.status === 429) {
      const kind = classifyRateLimit(text);
      const retryAfter = retryAfterSeconds(text);
      // The most reliable reading there is: the vendor itself saying "spent".
      // Recorded even when no header carried a number, because it corrects a
      // local counter that had drifted optimistic. `size` is excluded — that
      // 429 means this one prompt was too big, not that the allowance is gone,
      // and recording it as empty would take a working vendor out of service.
      if (kind !== "size") {
        report([readingFromRefusal(link, retryAfter)]);
      }
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
  const rawContent = firstText(choice?.message);
  const native = toolCallsFrom(choice?.message);

  // Read the line protocol out of the prose as well, unless the caller opted
  // out or offered no tools. Native wins on a tie: a model that emits BOTH the
  // real call and a prose echo of it must not run the tool twice — that wastes
  // a round trip and can double-propose an action.
  const wantsText = (options.toolProtocol ?? "both") === "both" && (options.tools?.length ?? 0) > 0;
  const fromText = wantsText
    ? parseTextToolCalls(rawContent, toolNamesFrom(options.tools)).filter((c) => {
        const key = `${c.name}:${c.args}`;
        return !native.some((n) => `${n.name}:${n.args}` === key);
      })
    : [];

  const toolCalls = [...native, ...fromText];
  // Strip the protocol lines only when they were actually read as calls.
  // Removing them without parsing would delete the evidence and leave a shorter
  // hallucination behind, which is worse than either extreme.
  const content = fromText.length > 0 ? stripToolCallLines(rawContent) : rawContent;

  // A 200 that carries neither text nor a tool call is an outage wearing a
  // success code — see the header. Demote, so the chain gets its chance.
  // Note the ordering: a reply that was ONLY a narrated call is now empty text
  // WITH tool calls, which is a valid turn, not an outage.
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

      // A REJECTED KEY is a verdict about the VENDOR, not the model.
      //
      // 401/403 says "not you". Every remaining link at this provider presents
      // the identical credential, so walking them spends a request each to be
      // told the same thing — and then reports "all 5 links failed", which
      // reads as an outage at someone else's shop and sends the reader looking
      // for one. The fact worth surfacing is that a key this app holds was
      // refused.
      //
      // Crossing to the NEXT vendor still happens: that is a different key, and
      // the whole reason the chain spans vendors.
      //
      // Deliberately narrow. A 404 is a retired id, a 5xx is a vendor being
      // unwell, a capacity 429 is a busy minute — all three are answered by
      // asking a different model, and widening this skip to cover them would
      // quietly turn the chain back into the pin it replaced.
      if (failure.status === 401 || failure.status === 403) {
        deadProviders.add(link.provider.id);
      }

      // The caller cancelled — the request they were waiting on is gone. Walking
      // the rest of the chain now would spend their daily budget on an answer
      // nobody will read, and would report "every vendor failed" about vendors
      // that were never asked.
      if (options.signal?.aborted) break;

      // Stepping down after a size 429 reaches a model with a smaller ceiling —
      // strictly worse. Stop, and let the caller shorten the prompt.
      if (failure.kind === "size") break;
    }
  }

  const exhausted = new ChainExhaustedError(failures);
  options.health?.recordFailure(exhausted);
  throw exhausted;
}
