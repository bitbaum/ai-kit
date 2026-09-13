/**
 * One GET /models, parsed once, for everything that needs to know what a vendor
 * currently offers.
 *
 * `catalog.ts` already fetched this list to answer "has a pinned id rotted".
 * `resolve.ts` needs the SAME request to answer "what else is on the shelf, and
 * what does the vendor say about it" — and the ids alone cannot answer that.
 *
 * Rather than issue a second, slightly different GET (the exact failure
 * catalog.ts's own header complains about — "the app that wrote its own first
 * wrote it slightly differently"), both read this.
 *
 * ── Two vendors, two schemas, one shape ──────────────────────────────────────
 * Verified against live responses on 2026-09-13, and they do NOT agree:
 *
 *   OpenRouter  architecture.output_modalities   supported_parameters: ["tools"]
 *   Groq        output_modalities (top level)    supported_features:   ["json_mode"]
 *
 * So a reader that knows only OpenRouter's shape reports every Groq model as
 * having no text output and no tools — which, in a filter, silently removes a
 * working vendor. Normalising here means each consumer states its requirement
 * once instead of learning both schemas.
 *
 * ── Unknown is a value, not a default ────────────────────────────────────────
 * Every normalised field is nullable, and null means "the vendor did not say".
 * That is deliberately distinct from false. A filter that treats "did not say"
 * as "does not support" narrows silently as vendors change their schemas; one
 * that treats it as "supports" invents capability. Callers must choose, and the
 * choice is visible at the call site because the type forces it.
 */

/** What a vendor's catalogue says about one model, in one shape. */
export type ModelRecord = {
  id: string;
  /** Output modalities, or null when the vendor does not publish them. */
  outputModalities: string[] | null;
  /**
   * True only when the vendor publishes a price and every component is zero.
   * Null when it publishes no price at all.
   *
   * Not the same question as "does the `:free` suffix appear". Checked live on
   * 2026-09-13: OpenRouter lists 19 ids ending `:free` and 22 priced at zero —
   * and the three zero-priced ids WITHOUT the suffix include `openrouter/free`,
   * the auto-router that is the most rot-resistant entry in the whole chain.
   * A suffix check misses it. Price is the vendor telling you who pays.
   */
  costsNothing: boolean | null;
  /** True when the vendor declares tool/function calling. Null when unstated. */
  tools: boolean | null;
  /** Vendor-declared context window, when published. */
  contextLength: number | null;
  /**
   * Date the vendor says this id stops working (ISO yyyy-mm-dd), when it says so.
   *
   * Rare but real: of 445 OpenRouter models on 2026-09-13, five carried one, and
   * one of those was a FREE model expiring in 17 days. Where present this turns
   * rot from something detected afterwards into something known in advance, so
   * it is worth surfacing even though most models omit it.
   */
  expiresOn: string | null;
};

type RawModel = Record<string, unknown>;

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : null;
}

/** Zero only when a price is published AND every numeric component is zero. */
function priceIsZero(pricing: unknown): boolean | null {
  if (!pricing || typeof pricing !== "object") return null;
  const entries = Object.entries(pricing as Record<string, unknown>);
  const numbers = entries
    .map(([, v]) => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN))
    .filter((n) => Number.isFinite(n));
  if (numbers.length === 0) return null;
  return numbers.every((n) => n === 0);
}

/** Tool support as DECLARED by the vendor, across both known schemas. */
function declaresTools(m: RawModel): boolean | null {
  const params = asStringArray(m.supported_parameters);
  if (params) return params.includes("tools");
  const features = asStringArray(m.supported_features);
  if (features) return features.some((f) => f === "tools" || f === "tool_use");
  return null;
}

function normalise(m: RawModel): ModelRecord | null {
  const id = typeof m.id === "string" ? m.id : "";
  if (!id) return null;
  const arch = (m.architecture ?? {}) as RawModel;
  const expires = m.expiration_date;
  return {
    id,
    outputModalities: asStringArray(arch.output_modalities) ?? asStringArray(m.output_modalities),
    costsNothing: priceIsZero(m.pricing),
    tools: declaresTools(m),
    contextLength: typeof m.context_length === "number" ? m.context_length : null,
    expiresOn: typeof expires === "string" && expires.trim() ? expires.trim() : null,
  };
}

export type FetchCatalogOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Every model one vendor lists, normalised — or NULL when the catalogue could
 * not be read.
 *
 * Null covers no key, a network failure, a non-200, an unparseable body, and a
 * body that parses but lists nothing. It never means "this vendor has no
 * models", and the distinction is not academic: while building this, a local
 * checkout missing GROQ_API_KEY answered 401, and a reader that collapsed that
 * into an empty list reported BOTH live Groq models as retired. Had resolution
 * trusted it, an expired key would have emptied the chain rather than failing a
 * single call.
 */
export async function fetchCatalog(
  baseUrl: string,
  key: string | undefined,
  opts: FetchCatalogOptions = {},
): Promise<ModelRecord[] | null> {
  if (!key?.trim()) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) return null;
    const records = body.data
      .map((m) => normalise((m ?? {}) as RawModel))
      .filter((m): m is ModelRecord => m !== null);
    return records.length > 0 ? records : null;
  } catch {
    return null;
  }
}
