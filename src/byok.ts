/**
 * Bring your own key: the reader's own vendor account, as a one-link chain.
 *
 * WHY THIS IS HERE AND NOT IN EACH APP
 *
 * Three apps grew three BYOK layers. OrangeCat keeps a provider table
 * (`ai-provider-runtime.ts`, seven base URLs); substrata kept a different one
 * (three vendors, one of them through a vendor SDK because nobody had noticed
 * Anthropic serves the OpenAI shape too); loki had none. Each list decided the
 * same three things — which hosts a server may send a stranger's key to, how
 * to turn that key into a call, and where to send the reader to get one — and
 * each got a different answer. This module is the one answer, so a vendor
 * added here reaches every app with a version bump.
 *
 * A CLOSED LIST, NOT A BASE URL
 *
 * The server makes the outbound request on the reader's behalf, with the
 * reader's bearer token attached. A caller-supplied base URL there is a
 * standing SSRF invitation that also exfiltrates the key. So the vendor is an
 * id from `BYOK_VENDORS`, and the host is looked up here — never read from the
 * request. A local model (Ollama, LM Studio) is deliberately absent: a server
 * cannot reach the reader's `localhost`, and pointing it at its own would be
 * the same SSRF with extra steps.
 *
 * EVERY VENDOR BELOW SPEAKS THE OPENAI CHAT-COMPLETIONS SHAPE
 *
 * Including Anthropic (`/v1/chat/completions` with `Authorization: Bearer`,
 * verified by OrangeCat on 2026-09-20: a bad key answers 401
 * `authentication_error` exactly like Groq's) and Google (the `/v1beta/openai`
 * surface `freeChain` already uses). So a reader's key goes through
 * `complete()` / `completeStream()` like every other link — streamed, with
 * native tool calls and the text-protocol fallback — instead of through a
 * vendor SDK per shape.
 *
 * Pure data and pure functions: safe to import from a browser bundle for the
 * settings UI. Nothing here makes a network call or stores a key.
 */
import type { Env, Link, Provider } from "./chain.js";

export type ByokVendorId =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "groq"
  | "mistral"
  | "deepseek"
  | "xai"
  | "together"
  | "cerebras";

export interface ByokVendor {
  id: ByokVendorId;
  /** What a reader calls it. */
  label: string;
  /** OpenAI-compatible base, without `/chat/completions`. Never from a request. */
  baseUrl: string;
  /** Where a reader creates a key. */
  keyUrl: string;
  /** A hint for the input's placeholder. Not validation: formats change without notice. */
  keyHint: string;
  /** A model-id example for the placeholder. An example, not a default a call relies on. */
  modelExample: string;
  /** Routed ids (`vendor/model`, `:free`) — see `Provider.routed`. */
  routed?: boolean;
  /** Attribution headers some vendors read; free to send. */
  wantsAttribution?: boolean;
}

/**
 * The vendors a reader can bring. Ordered for a picker: the one-key-many-models
 * router first, then the frontier labs, then the fast/open-weight hosts.
 */
export const BYOK_VENDORS: readonly ByokVendor[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-…",
    modelExample: "anthropic/claude-sonnet-5",
    routed: true,
    wantsAttribution: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    modelExample: "gpt-5.1",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    modelExample: "claude-opus-5",
  },
  {
    id: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    modelExample: "models/gemini-flash-latest",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "gsk_…",
    modelExample: "openai/gpt-oss-120b",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyHint: "",
    modelExample: "mistral-large-latest",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
    modelExample: "deepseek-chat",
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    keyHint: "xai-…",
    modelExample: "grok-4",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    keyHint: "",
    modelExample: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai",
    keyHint: "csk-…",
    modelExample: "gpt-oss-120b",
  },
];

export const BYOK_VENDOR_IDS: readonly ByokVendorId[] = BYOK_VENDORS.map((v) => v.id);

export function byokVendor(id: string): ByokVendor | undefined {
  return BYOK_VENDORS.find((v) => v.id === id);
}

/** A reader's own key and the model they picked at that vendor. */
export interface ByokConfig {
  vendor: ByokVendorId;
  apiKey: string;
  model: string;
}

/**
 * A vendor id, a header value and a model id — not free text.
 *
 * The bounds stop megabytes through a JSON field and a header smuggled via a
 * newline. They do not second-guess a vendor's key format, which changes
 * without notice and is none of this module's business.
 */
export function isByokConfig(input: unknown): input is ByokConfig {
  if (!input || typeof input !== "object") return false;
  const { vendor, apiKey, model } = input as Record<string, unknown>;
  if (typeof vendor !== "string" || !byokVendor(vendor)) return false;
  if (typeof apiKey !== "string" || apiKey.length < 8 || apiKey.length > 400) return false;
  if (typeof model !== "string" || model.length < 1 || model.length > 200) return false;
  if (/[\r\n\s]/.test(apiKey) || /[\r\n]/.test(model)) return false;
  return true;
}

/** "Anthropic · claude-opus-5" — for a prompt or a footer. Never the key. */
export function byokLabel(config: Pick<ByokConfig, "vendor" | "model">): string {
  return `${byokVendor(config.vendor)?.label ?? config.vendor} · ${config.model}`;
}

/** The last four characters, for "key ending …abcd". Never more. */
export function byokKeyHint(apiKey: string): string {
  return apiKey.length > 12 ? `…${apiKey.slice(-4)}` : "…";
}

const KEY_ENV = "BYOK_API_KEY";

/**
 * The reader's key as something `complete()` / `completeStream()` accept.
 *
 * The env is a one-entry object scoped to this call — never `process.env` —
 * so the key cannot reach any other caller reading the same object, and a
 * deployment's own key of the same vendor is never mixed in.
 *
 * `site` (optional) fills the attribution headers OpenRouter publishes on its
 * app pages; sending them on someone else's key is the polite default.
 */
export function byokChain(
  config: ByokConfig,
  site?: { url: string; title: string },
): { chain: Link[]; env: Env; extraHeaders?: Record<string, string> } {
  const vendor = byokVendor(config.vendor);
  if (!vendor) throw new Error(`Unknown BYOK vendor: ${config.vendor}`);
  const provider: Provider = {
    id: vendor.id,
    baseUrl: vendor.baseUrl,
    keyEnv: KEY_ENV,
    models: [config.model],
    // Required by the type, meaningless here: a reader's own key is metered by
    // their own vendor account, not by any fair-share in this process.
    dailyTokens: Number.POSITIVE_INFINITY,
    ...(vendor.routed ? { routed: true } : {}),
  };
  return {
    chain: [{ provider, model: config.model }],
    env: { [KEY_ENV]: config.apiKey },
    ...(vendor.wantsAttribution && site
      ? { extraHeaders: { "HTTP-Referer": site.url, "X-Title": site.title } }
      : {}),
  };
}
