/**
 * What a model can actually do, as OBSERVED rather than as claimed.
 *
 * The problem this exists for: capability is not a property of a model name.
 * It is a property of a model, on a provider, through a particular deployment,
 * reached with a particular credential. A quantized local build drops tool
 * support the upstream weights have. A proxy strips `tool_calls`. An org's key
 * has vision disabled. A vendor updates a model in place behind an alias. None
 * of that is knowable from a name, and every one of it is knowable by asking
 * once.
 *
 * So this module holds no list of models. It holds the shape of an observation,
 * the rules for turning a real call into one, and the decision of what to send
 * next time. The list every app is tempted to write — "these providers support
 * tools" — is the thing being replaced: it was wrong the day a user brought a
 * model nobody had heard of, which is every day.
 */

/**
 * How a model answers a request carrying tool definitions.
 *
 * Four values, and the fourth is the one that matters. `unobserved` is not a
 * synonym for `none`: it means nobody has ever asked, and a system that treats
 * it as `none` silently disables tools for every model it has not met yet,
 * while a system that treats it as `native` promises a capability it cannot
 * demonstrate. It has to stay its own answer all the way to the user.
 */
export type ToolVerdict = "native" | "text" | "none" | "unobserved";

/** What a single capability question is asked about. */
export type CapabilityKind = "tools" | "vision";

/** How we came to believe something, ordered weakest to strongest. */
export type Provenance =
  /** The vendor's docs or a hand-maintained registry. A prior, never a fact. */
  | "declared"
  /** A deliberate probe request made to answer this question. */
  | "probe"
  /** Real traffic the user asked for, which answered it for free. */
  | "live";

export type CapabilityRecord = {
  provider: string;
  model: string;
  /**
   * Which credential this was observed through — a HASH, never the key.
   * Capability differs per key (an org with vision disabled, a proxy that
   * strips tool calls), so an observation made with one credential is not
   * evidence about another.
   */
  scope: string;
  capability: CapabilityKind;
  verdict: ToolVerdict;
  /** ISO 8601. Used for staleness; models change under their own names. */
  observedAt: string;
  via: Provenance;
  /** Short, human-readable reason. Goes in logs and in the UI. */
  evidence?: string;
};

/**
 * Storage is the app's problem — a table, a KV, a file. This package owns the
 * shape and the rules, because those are what every app gets wrong; it does not
 * own where the rows live, because that is the one part where apps legitimately
 * differ.
 */
export type CapabilityStore = {
  get(key: {
    provider: string;
    model: string;
    scope: string;
    capability: CapabilityKind;
  }): Promise<CapabilityRecord | null>;
  put(record: CapabilityRecord): Promise<void>;
};

/** The outcome of reading one real response for what it says about capability. */
export type Classification = {
  verdict: ToolVerdict;
  /**
   * Whether this is worth WRITING DOWN. A response can be uninformative —
   * a 429, a 500, a timeout, a 400 about something other than tools — and
   * recording those is how a model gets wrongly marked incapable forever.
   */
  record: boolean;
  evidence: string;
};
