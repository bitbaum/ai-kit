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
 *   ACROSS VENDORS — the one that actually buys headroom. Stepping down to a
 *                    smaller model at the SAME vendor draws on the SAME org-wide
 *                    daily budget, so when the day runs dry every link in that
 *                    "fallback" is already dead. Only a different vendor has a
 *                    different meter.
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
export function withEnvPrefix(prefix: string, provider: Omit<Provider, "modelsEnv" | "dailyTokensEnv">): Provider {
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
      models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
      // Not a guess: Groq's own TPD refusal names it — "on tokens per day
      // (TPD): Limit 100000". Org-wide, so every feature sharing the key draws
      // from this same pool.
      dailyTokens: 100_000,
    }),
    withEnvPrefix(prefix, {
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      keyEnv: "OPENROUTER_API_KEY",
      models: [
        "openai/gpt-oss-20b:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "nvidia/nemotron-3.5-lightning:free",
        "google/gemma-4-26b-a4b-it:free",
        "nvidia/nemotron-3-nano-30b-a3b:free",
        "cohere/north-mini-code:free",
        "openrouter/free",
      ],
      // OpenRouter meters its free tier in REQUESTS per day, not tokens, and the
      // cap depends on the account's credit balance — so this is a translation,
      // not a published figure. Set at the low end on purpose.
      dailyTokens: 100_000,
    }),
  ];
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
