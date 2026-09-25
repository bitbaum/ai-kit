/**
 * The provider CHAIN — a list, never a pin.
 *
 * This exists because of a failure that repeated across several projects before
 * anyone named it: an app picks one free model, ships, and works. Then the model
 * is retired, or the vendor's daily budget runs out, and the app is simply down
 * — with an error that looks like a bug in the app rather than an empty tier.
 * A single pinned free model is not a configuration, it is a scheduled outage.
 *
 * Two properties do the work, and BOTH are needed:
 *
 *   ACROSS MODELS  — a rotted or momentarily busy model steps aside for the
 *                    next one.
 *   ACROSS VENDORS — usually the one that actually buys headroom, because the
 *                    vendor's daily TOKEN budget is typically org-wide: when the
 *                    day runs dry, every model behind that key is dry with it.
 *
 * That second rule needs one correction, because taken absolutely it is wrong
 * and it costs free capacity. Groq rations REQUESTS and TPM per MODEL. Measured
 * from `x-ratelimit-*` headers on one key, within the same minute, 2026-09-13:
 *
 *     openai/gpt-oss-20b    591 / 1000 requests remaining   (the model in use)
 *     openai/gpt-oss-120b   999 / 1000
 *     qwen/qwen3.8-27b      999 / 1000
 *
 * Separate counters, and separate 8000-token windows. So a second model at the
 * same vendor IS a real fallback while you are request- or TPM-limited — the
 * common case. The tokens-per-DAY pool was assumed org-wide; re-measured
 * 2026-09-25 it is per model too (gpt-oss-20b refused "for model
 * `openai/gpt-oss-20b` … TPD" while gpt-oss-120b served on the same key), and
 * a rolling 24 hours rather than a UTC day. `walkChain` therefore condemns the
 * vendor only for a daily refusal that names no model. Worth knowing precisely, because the vendor
 * after Groq is often OpenRouter's free tier at 50 requests/day.
 *
 * The general rule stands: check the vendor's own headers rather than assuming
 * one pool per account. `meter` reads them off calls already made.
 *
 * Every provider here speaks the OpenAI chat-completions shape, so adding one is
 * a row in a table rather than a new client.
 *
 * ── Before pinning a model, PROBE IT ─────────────────────────────────────────
 * A model that cannot emit a parseable tool call cannot drive a tool loop, and
 * that is not guessable from its name, size, or docs. Of nine free models probed
 * live for the default chain below, FIVE answered only via a text protocol and
 * not via native `tool_calls` — so a native-only client would have silently lost
 * most of the chain. Probe with a real tool call, not a docs page.
 *
 * ── Environment is passed in, never read from a global ───────────────────────
 * Every function here takes `env`, defaulting to `process.env`. That keeps the
 * module testable without mutating global state, and makes the override points
 * explicit rather than discovered by grep.
 */

/** A vendor, its endpoint, and the free models worth trying on it, in order. */
export type Provider = {
  /** Display/debug name; also the prefix reported back as the model id. */
  id: string;
  baseUrl: string;
  /** Env var holding the API key. Absent key = entry skipped, not an error. */
  keyEnv: string;
  /** Models to try for this provider, in order. */
  models: string[];
  /**
   * Tokens this vendor's FREE tier grants per day, summed into the pool that
   * fair-share rations. An ESTIMATE unless the vendor states it: handing out
   * shares of capacity that turns out not to exist produces the exact wall the
   * rationing exists to prevent, only later in the day and harder to diagnose.
   * So estimate LOW.
   */
  dailyTokens: number;
  /**
   * Env var that REPLACES `models` when set (comma/space separated).
   * Read at CALL time, not at import: the point of this override is routing
   * around a model that rotted, and a value frozen at module load would need a
   * redeploy to take effect — which is exactly the delay it exists to avoid.
   */
  modelsEnv?: string;
  /** Env var overriding `dailyTokens` at call time. */
  dailyTokensEnv?: string;
  /**
   * Does this vendor use ROUTED ids, where `vendor/model` names weights it
   * resells and a `:free` suffix is the difference between free routing and a
   * per-call charge? True for OpenRouter.
   *
   * It matters because the same STRING means different things at different
   * vendors. `openai/gpt-oss-20b` bills at OpenRouter (no `:free`), while at
   * Groq it is simply that vendor's name for a model whose cost depends on the
   * account tier. Deciding cost from the id alone was safe only while
   * non-routed vendors used bare ids like `llama-3.1-8b-instant`; Groq now
   * ships vendor-prefixed ids, so the shape no longer identifies the vendor.
   *
   * Defaults to false: claiming an id is routed when it is not would report a
   * free model as paid, and the reverse — assuming free — is the direction
   * this module exists to refuse.
   */
  routed?: boolean;
  /**
   * Which of `models` accept an IMAGE as input. Absent = nobody has said.
   *
   * Three states, not two, and the third is the one that matters — the same
   * shape as `ToolVerdict.unobserved` in `capability/`, for the same reason. A
   * model listed here reads pictures. A model in `models` but NOT here is
   * declared blind, and a picture must not be sent to it. A model in NEITHER
   * list — an env override, a private deployment, an id a user brought — is
   * UNKNOWN, and unknown is tried rather than refused: asking is how we learn,
   * and a list that reads its own silence as "no" permanently refuses a
   * capability it never tested. That is the precise bug OrangeCat's ADR-0008
   * was written about (`TOOL_CAPABLE_PROVIDERS = ['groq', 'openrouter']`).
   *
   * Set it ONLY from evidence, and say which kind in a comment beside the id.
   * `scripts/probe-vision.mjs` produces the strong kind.
   */
  visionModels?: string[];
};

export type Env = Record<string, string | undefined>;

/** One attempt: a model at a provider. */
export type Link = { provider: Provider; model: string };

function readEnv(env: Env, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return env[name]?.trim() || undefined;
}

/** Split a comma/space separated env override into model ids. */
function modelsFromEnv(env: Env, name: string | undefined): string[] | null {
  const raw = readEnv(env, name);
  if (!raw) return null;
  const models = raw.split(/[\s,]+/).filter(Boolean);
  return models.length > 0 ? models : null;
}

/** This provider's models, honouring its env override. */
export function providerModels(provider: Provider, env: Env = process.env): string[] {
  return modelsFromEnv(env, provider.modelsEnv) ?? provider.models;
}

/**
 * Build a provider row whose env var names follow one prefix.
 *
 * Saves each app from inventing its own naming and then documenting it: with
 * prefix "LOKI" a provider `groq` reads LOKI_GROQ_MODELS and
 * LOKI_GROQ_DAILY_TOKENS. The key env stays explicit because it is usually the
 * vendor's conventional name (GROQ_API_KEY), shared with other tools.
 */
export function withEnvPrefix(
  prefix: string,
  provider: Omit<Provider, "modelsEnv" | "dailyTokensEnv">,
): Provider {
  const slug = provider.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    ...provider,
    modelsEnv: `${prefix}_${slug}_MODELS`,
    dailyTokensEnv: `${prefix}_${slug}_DAILY_TOKENS`,
  };
}

/**
 * A default chain of FREE models, every entry probed live on 2026-08-15 with a
 * real tool call. Protocol each answered on:
 *
 *   groq/llama-3.3-70b-versatile              native
 *   groq/llama-3.1-8b-instant                 text
 *   openai/gpt-oss-20b:free                   native
 *   nvidia/nemotron-3-super-120b-a12b:free    native
 *   nvidia/nemotron-3.5-lightning:free        native
 *   google/gemma-4-26b-a4b-it:free            text
 *   nvidia/nemotron-3-nano-30b-a3b:free       text
 *   cohere/north-mini-code:free               text
 *   openrouter/free                           text
 *
 * Deliberately excluded, both verified rather than assumed:
 *   google/gemma-4-31b-it:free      — "Provider returned error" on probe
 *   nvidia/nemotron-nano-12b-v2-vl  — returns HTTP 200 with EMPTY content, which
 *                                     a naive client reads as a successful
 *                                     empty answer
 *
 * `openrouter/free` sits last on purpose: it is an auto-router across the free
 * catalogue, so it keeps working when a specific id above it is retired. That
 * makes it the link most likely to survive the next rot, and the least
 * predictable in quality — exactly the right shape for a last resort.
 *
 * NOTE the shelf life. This list is evidence from one day, not a constant; free
 * catalogues rot. Treat it as a starting point and re-probe.
 */
export function freeChain(prefix = "AI"): Provider[] {
  return [
    withEnvPrefix(prefix, {
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      keyEnv: "GROQ_API_KEY",
      // Re-probed 2026-08-25 against the live catalog. The previous pins,
      // `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`, were BOTH gone —
      // so this "fallback chain" led with a fully dead vendor and every caller
      // paid two 404s before reaching OpenRouter. Loki, whose direct
      // (non-chain) calls used the same id and had no fallback at all, was
      // silently down for eight days. Both ids below answered with a correct
      // native tool_call when probed, which is the bar this list is held to.
      // Four links, not two, and the extra two are the direct consequence of
      // the per-MODEL rationing documented above: each id carries its own
      // minute window, so a same-vendor link IS real headroom here.
      //
      // Probed live 2026-09-13 with a real tool call, same prompt the loop
      // sends. Protocol each answered on, and the window each reported back
      // within the same minute — three distinct counters, which is the whole
      // argument for listing them:
      //
      //   openai/gpt-oss-120b   native   7,551 / 8,000 tokens this minute
      //   openai/gpt-oss-20b    native
      //   qwen/qwen3.8-27b      text     7,360 / 8,000
      //   qwen/qwen3.6-27b      text     7,362 / 8,000
      //
      // The Qwen pair answer via the TEXT protocol only — no native
      // `tool_calls` — which is exactly the case a native-only client loses
      // silently, and exactly why `complete()` parses both. They sit after the
      // native pair because native is the surer parse, not because they are
      // weaker: both returned correct arguments, and both carry 131k context.
      //
      // They also sit BEFORE OpenRouter deliberately, as does Google below.
      // OpenRouter's unpaid tier is 50 REQUESTS a day for the whole account, so
      // every other pool worth draining should be drained before one of those
      // 50 is spent. That makes OpenRouter the LAST link rather than a middle
      // one, despite being the widest catalogue.
      //
      // 2026-09-25: `qwen/qwen3.6-27b` left Groq's catalogue and 404'd on every
      // turn that reached it (seen in substrata's Ask timing log); removed. The
      // catalogue that day: gpt-oss-120b, gpt-oss-20b, qwen3.8-27b.
      models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
      // NONE of them can read a picture, and this empty list is a statement,
      // not an oversight — it is what stops a screenshot being sent to the
      // four links that lead this chain.
      //
      // Evidence, live rather than assumed: loki pinned
      // `meta-llama/llama-4-scout-17b-16e-instruct` for screenshot analysis,
      // the id was DECOMMISSIONED, and re-probing on 2026-08-13 established
      // that Groq then offered no vision model at all on this account
      // (bitbaum/loki `src/config/vision-models.ts`, which kept an empty Groq
      // seat for exactly that reason). gpt-oss and qwen3 are text models.
      //
      // Restore an id here the day Groq serves one and a probe proves it.
      visionModels: [],
      // Deliberately NOT raised alongside the model count, and that is the
      // whole point of the split documented at the top of this file: requests
      // and TPM ration per MODEL, the daily TOKEN pool does not. Four links
      // therefore buy four minute windows and four request counters — real
      // headroom, most of the time — and not one extra daily token.
      //
      // Multiplying this by the model count would be the precise failure this
      // field's contract warns about: fair-share handing out shares of capacity
      // that does not exist, with the wall arriving later in the day and harder
      // to diagnose.
      //
      // The figure stays below what one key was seen to grant — Groq's own TPD
      // refusal read "Limit 200000" on 2026-09-13 — because free tiers differ
      // per account and the instruction on this field is to estimate LOW.
      // Under-promising costs a few rationed turns; over-promising costs the
      // rationing.
      dailyTokens: 100_000,
    }),
    withEnvPrefix(prefix, {
      id: "google",
      // The OpenAI-COMPATIBLE surface, and it took a real key to establish that
      // it exists at all. Unkeyed, `/v1beta/openai/models` answers 404 — which
      // is why this vendor was written off once as "the compat layer likely
      // serves /chat/completions without a catalogue, so its ids could never be
      // rot-checked". With a key the same path answers 200 and lists 56 models.
      // An unkeyed probe cannot tell "absent" from "hidden behind auth", in
      // either direction.
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      keyEnv: "GEMINI_API_KEY",
      // ── THE `models/` PREFIX IS LOAD-BEARING ────────────────────────────────
      // The catalogue lists all 56 ids prefixed, with NO bare form anywhere,
      // while /chat/completions accepts BOTH (verified 2026-09-15 across
      // max_tokens 64/256/1024 — identical answers either way).
      //
      // So a bare `gemini-flash-latest` would serve perfectly in production AND
      // be reported missing by `checkCatalog` on every run. That is a permanent
      // false rot alarm about a model that works, which is worse than no alarm:
      // it teaches the reader to ignore the one that matters.
      //
      // ── ALIASES, NOT VERSIONS ───────────────────────────────────────────────
      // `-latest` is repointed by Google as the model behind it retires, the
      // same property that makes `openrouter/free` the most durable entry in
      // the list below. Not theoretical: `gemini-2.5-flash`, the id reached for
      // from memory, is already refused for new accounts — "no longer available
      // to new users, please update your code to use models/gemini-3.6-flash".
      //
      // `gemma-4-31b-it` is last and earns its place differently: Google's
      // pricing lists it as free-tier-only with no paid column at all, so it is
      // the one id here that cannot be quietly reclassified as billable.
      //
      // All three answered a real tool-call probe with a NATIVE `tool_calls`
      // response on 2026-09-15, which is the bar this file holds ids to.
      models: [
        "models/gemini-flash-latest",
        "models/gemini-flash-lite-latest",
        "models/gemma-4-31b-it",
      ],
      // All three, and this is the vendor that makes free vision possible at
      // all: Gemini Flash and Gemma are multimodal families, and Google's free
      // tier is per-PROJECT rather than org-wide, so it is not drained by
      // whatever else on the box shares the Groq and OpenRouter keys.
      //
      // PROVENANCE: declared, not probed. Google publishes image input for
      // these families and the OpenAI-compatible surface takes `image_url`
      // parts — but nobody in this fleet has sent one through and watched it
      // answer, which is the bar `models` above is held to. Declared is a
      // legitimate prior (see `capability/types.ts`); it is not a measurement,
      // and it is written down as such so the next reader does not inherit it
      // as one. `pnpm run check:vision` settles it with a real image.
      visionModels: [
        "models/gemini-flash-latest",
        "models/gemini-flash-lite-latest",
        "models/gemma-4-31b-it",
      ],
      // Google publishes no fixed free-tier table — limits are per PROJECT and
      // shown in AI Studio, and no rate-limit headers come back on a completion
      // either. So this is a deliberate under-estimate rather than a figure, per
      // this field's contract: a share of capacity that turns out not to exist
      // produces the exact wall the rationing exists to prevent.
      //
      // Being per-project is itself the point of adding this vendor. Groq's
      // daily token pool is org-wide and OpenRouter's 50 requests are
      // account-wide, so on a box where several apps share those keys they
      // share the exhaustion too. A Google project is one app's own.
      dailyTokens: 50_000,
    }),
    withEnvPrefix(prefix, {
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      keyEnv: "OPENROUTER_API_KEY",
      // Routed ids: `:free` is the whole difference between free routing and a
      // per-call charge for the same weights. See Provider.routed.
      routed: true,
      // Re-checked 2026-08-25 against the 419-model live catalog. Two entries
      // were retired and are removed here: `openai/gpt-oss-20b:free` — which
      // was FIRST, so the preferred fallback 404'd on every call — and
      // `nvidia/nemotron-3-nano-30b-a3b:free`. The five below were present.
      models: [
        "nvidia/nemotron-3-super-120b-a12b:free",
        "nvidia/nemotron-3.5-lightning:free",
        "google/gemma-4-26b-a4b-it:free",
        "cohere/north-mini-code:free",
        "openrouter/free",
      ],
      // One entry, and it is the strongest evidence in this file: loki probed
      // `google/gemma-4-26b-a4b-it:free` LIVE on 2026-08-13 with a
      // solid-colour test image and it answered "Red" correctly. A free model,
      // already in this chain, that reads pictures — which is why heidi's
      // "the free models cannot read pictures" was never a fact about free
      // models, only about a chain nobody had taught to route.
      //
      // The four omissions are each deliberate:
      //   nemotron-3-super / nemotron-3.5-lightning / cohere/north-mini-code
      //     — text models.
      //   openrouter/free — an AUTO-ROUTER across the free catalogue. It may
      //     land on something that sees, and it may not, and which one is not
      //     knowable before the call. Unreliable is not a capability: a
      //     picture routed to a blind model comes back as a confident answer
      //     about nothing, which is worse than a refusal.
      //
      // `google/gemma-4-31b-it:free` is NOT here because it is not in `models`
      // above. It answered 429 on loki's probe day — unproven either way.
      visionModels: ["google/gemma-4-26b-a4b-it:free"],
      // OpenRouter meters its free tier in REQUESTS per day, not tokens, and the
      // cap depends on the account's credit balance — so this is a translation,
      // not a published figure. Set at the low end on purpose.
      dailyTokens: 100_000,
    }),
  ];
}

/** What a model id tells us about who pays. */
export type CostVerdict = "free" | "paid" | "unknown";

/**
 * Does this model id cost money?
 *
 * Exists because the same mistake was found in THREE separate apps on one day,
 * each a fallback that silently began spending when the free tier ran dry:
 *
 *   anthropic/claude-sonnet-5                  a premium model as the fallback
 *   google/gemini-2.0-flash-001                the paid twin of a `:free` id
 *   meta-llama/llama-3.3-70b-instruct          reads free; bills at 1e-7/token,
 *                                              and its `:free` sibling has been
 *                                              retired from the catalogue
 *
 * The decidable rule is narrow and stated as such. A routed id (`vendor/model`,
 * the OpenRouter shape) is FREE only with the `:free` suffix, and PAID without
 * it — that suffix is the entire difference between free routing and a per-call
 * charge for the same weights. A bare id (`llama-3.1-8b-instant`) says nothing:
 * whether it costs depends on the account's tier at that vendor, which no string
 * can answer, so it returns "unknown" rather than guessing.
 *
 * Guessing "free" there would be the dangerous direction — it is what let three
 * of these through code review.
 *
 * IMPORTANT: this reads the id as a ROUTED (OpenRouter-shape) id, because that
 * is the only shape where the string decides. It is therefore wrong to apply to
 * an id from a vendor that merely happens to prefix its own models — Groq's
 * `openai/gpt-oss-120b` is not a routed OpenAI id, and this function would call
 * it paid. When you know the provider, use `modelCostAt`; `paidModelsIn` does.
 */
export function modelCost(id: string): CostVerdict {
  const model = id.trim();
  if (!model) return "unknown";
  // OpenRouter's auto-router across the free catalogue.
  if (model === "openrouter/free") return "free";
  if (!model.includes("/")) return "unknown";
  return model.endsWith(":free") ? "free" : "paid";
}

/**
 * Cost of a model AT a specific provider — the honest signature, because the
 * same id answers differently at different vendors (see `Provider.routed`).
 *
 * At a non-routed vendor the id carries no cost information at all: what you
 * pay is the account's tier there, which no string can report. That is the
 * same "unknown" a bare id has always returned, now correct for vendor-prefixed
 * ids too.
 */
export function modelCostAt(provider: Provider, model: string): CostVerdict {
  return provider.routed ? modelCost(model) : "unknown";
}

/**
 * Assert every model in a chain is free, for apps that must never bill.
 *
 * Judges each id AT ITS PROVIDER. Flagging Groq's `openai/gpt-oss-120b` as paid
 * because it contains a slash would be a false alarm that pressures someone
 * into "fixing" a working free model — and a guard that cries wolf gets
 * disabled, taking the three real cases it does catch with it.
 *
 * Returns the offending ids rather than throwing: the caller knows whether a
 * paid link is a bug or a deliberate, opted-in upgrade, and a library that
 * throws on the second case forces people to route around it.
 */
export function paidModelsIn(chain: Provider[]): string[] {
  return chain.flatMap((p) => p.models.filter((m) => modelCostAt(p, m) === "paid"));
}

/**
 * The day's total budget: every provider we hold a key for.
 *
 * Only KEYED providers count. A vendor whose key is absent contributes nothing
 * however generous its tier, and counting it would ration users against capacity
 * that cannot be reached — the same failure as an optimistic estimate, just with
 * an obvious cause.
 */
export function dayCapacityTokens(chain: Provider[], env: Env = process.env): number {
  let total = 0;
  for (const provider of chain) {
    if (!readEnv(env, provider.keyEnv)) continue;
    const override = Number(readEnv(env, provider.dailyTokensEnv));
    total += Number.isFinite(override) && override >= 0 ? override : provider.dailyTokens;
  }
  return total;
}

/**
 * The chain with unusable entries removed: no API key, or no models configured.
 *
 * A missing key is a normal deployment state — most boxes carry one vendor's
 * key, not every vendor's — so it filters out silently rather than throwing.
 */
export function usableChain(chain: Provider[], env: Env = process.env): Link[] {
  const out: Link[] = [];
  for (const provider of chain) {
    if (!readEnv(env, provider.keyEnv)) continue;
    for (const model of providerModels(provider, env)) out.push({ provider, model });
  }
  return out;
}

/**
 * The chain starting at `model`, or the whole chain when it names no link.
 *
 * Apps commonly carry a "use this model" env var. Honouring it as a STARTING
 * POINT rather than a hard pin keeps that escape hatch while refusing to
 * reintroduce the single point of failure this module exists to remove: an
 * operator pinning a model should still get a fallback when that model's vendor
 * runs dry.
 */
export function chainFrom(model: string | undefined, chain: Link[]): Link[] {
  const wanted = model?.trim();
  if (!wanted) return chain;
  const at = chain.findIndex((l) => l.model === wanted);
  if (at >= 0) return chain.slice(at);
  // A model nobody advertises is still a legitimate request (a private
  // deployment, a just-released id). Try it against the first provider that has
  // a key, then fall through to the ordinary chain rather than dead-ending.
  const host = chain[0];
  return host ? [{ provider: host.provider, model: wanted }, ...chain] : [];
}
