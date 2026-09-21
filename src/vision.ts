/**
 * Can the link we are about to call actually SEE?
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `complete()` has forwarded `image_url` parts untouched since the first
 * release. What it has never done is CHOOSE a link for them. The chain is
 * ordered for text, so a screenshot sent through `freeChain()` meets four Groq
 * links that cannot read it before it reaches one that can — and a blind model
 * handed a picture does not error helpfully. It answers the words around the
 * image, fluently, about nothing.
 *
 * Three products paid for that absence separately, and each paid a different
 * way:
 *
 *   heidi     had the users — a screenshot of a WhatsApp thread is the single
 *             most valuable thing someone can hand it — and REFUSED them.
 *             `/api/chat` returned 400 "Reading a picture needs your own
 *             model", and `byok.ts` stated as fact that "the free chain has no
 *             model that can read a picture". It was never true of free
 *             models; it was true of a chain with no vision routing.
 *   loki      needed it to work, so it built a SECOND chain
 *             (`src/config/vision-models.ts`) beside the one this package
 *             owns — the exact duplication ai-kit exists to prevent, and it
 *             drifted immediately: it never learned about Google, and it still
 *             carries a dead Groq seat.
 *   orangecat built the decision rule and had nobody to call it with.
 *             `services/cat/capability-gate.ts` reasons about vision properly
 *             and its own reason string reads `'no caller sends images'`.
 *
 * The routing rule, the verified model list and the users were in three
 * repositories and none of them could reach the other two. That is the whole
 * argument for putting it here.
 *
 * ── The rule, in one sentence ────────────────────────────────────────────────
 *
 * A request carrying an image skips the links DECLARED blind, tries the ones
 * declared sighted and the ones nobody has classified, and — if that leaves
 * nothing — says so in its own error rather than reporting every vendor down.
 *
 * ── Unknown is tried, never refused ──────────────────────────────────────────
 *
 * This is the same three-answer shape as `capability/`, and it is load-bearing
 * in the same way. A user's own key points at a chain this package never built
 * and has no `visionModels` for. Reading that silence as "cannot see" would
 * refuse a picture to the person who is PAYING for a frontier model — which is
 * precisely the inversion OrangeCat's ADR-0008 was written about, where the
 * stronger your model, the weaker your agent. Optimistic on the wire;
 * pessimistic in the UI, which is the caller's half.
 */
import type { Link, Provider } from "./chain.js";
import { providerModels, type Env } from "./chain.js";
import type { ChatMessage, ContentPart } from "./complete.js";

/**
 * What we know about one model's ability to read an image.
 *
 * `"unknown"` is not a synonym for `"no"`. See the header.
 */
export type VisionVerdict = "yes" | "no" | "unknown";

/**
 * Does this model, at this provider, accept an image?
 *
 * A provider with no `visionModels` says nothing about any of its models, so
 * every one of them is `"unknown"` — that is a vendor nobody has classified,
 * not a vendor that failed a test.
 *
 * The `"no"` verdict is deliberately narrow: it requires the model to appear
 * in the provider's DECLARED `models` list while absent from `visionModels`.
 * An id that appears in neither — an env override (`HEIDI_GOOGLE_MODELS`), a
 * private deployment, a model released this morning — is `"unknown"`, because
 * a list written in August cannot have an opinion about it. Without that
 * carve-out, the `modelsEnv` override that exists to route around rot would
 * silently disable vision, and nothing would say why.
 */
export function modelSeesImages(provider: Provider, model: string): VisionVerdict {
  const declared = provider.visionModels;
  if (!declared) return "unknown";
  const wanted = model.trim();
  if (declared.includes(wanted)) return "yes";
  return provider.models.includes(wanted) ? "no" : "unknown";
}

/** The same question about a whole link. */
export function linkSeesImages(link: Link): VisionVerdict {
  return modelSeesImages(link.provider, link.model);
}

/**
 * The links worth sending a picture to: the sighted and the unclassified.
 *
 * Order is preserved rather than re-sorted. The chain's order encodes which
 * meter to drain first — Google's per-project quota before OpenRouter's fifty
 * account-wide requests a day — and that reasoning does not stop applying
 * because the request has an image in it.
 */
export function seeingLinks(links: Link[]): Link[] {
  return links.filter((link) => linkSeesImages(link) !== "no");
}

/**
 * Every provider narrowed to the models that can read an image.
 *
 * For a caller that wants a vision chain up front rather than one filtered per
 * request — a preflight that turns a screenshot into text, say, where the
 * whole job is the picture. Providers left with no sighted model are dropped,
 * so a chain of one vendor is possible and a chain of none is honest.
 *
 * `unknown` models are NOT included here, and that asymmetry with
 * `seeingLinks` is deliberate: filtering a request is a decision about what to
 * skip, where optimism costs one wasted call; building a dedicated vision
 * chain is a decision about what to promise, where optimism means claiming a
 * capability on no evidence.
 */
export function visionProviders(chain: Provider[], env: Env = process.env): Provider[] {
  const out: Provider[] = [];
  for (const provider of chain) {
    // Honour `modelsEnv` first, then keep only what is both live and sighted —
    // an operator who overrode the model list has not thereby authorised us to
    // send pictures to whatever they named.
    const live = providerModels(provider, env);
    const models = live.filter((m) => modelSeesImages(provider, m) === "yes");
    if (models.length > 0) out.push({ ...provider, models });
  }
  return out;
}

/** Is this message carrying at least one image part? */
function messageHasImage(message: ChatMessage): boolean {
  const content = message.content;
  if (typeof content === "string") return false;
  return content.some((part: ContentPart) => part.type === "image_url");
}

/**
 * Does this turn contain a picture at all?
 *
 * The cheap question that gates everything else here. Answered `false` for the
 * overwhelming majority of calls — every plain-text turn in the fleet — so the
 * vision path costs a `typeof` check and nothing more.
 */
export function messagesCarryImages(messages: ChatMessage[]): boolean {
  return messages.some(messageHasImage);
}

/**
 * The request carried a picture and every link in the chain is declared blind.
 *
 * Its own error type, because "no model here can see" and "every vendor failed"
 * need different answers from the caller and are indistinguishable once both
 * arrive as `ChainExhaustedError`. The first is a configuration fact known
 * BEFORE any request was made — no key for a sighted vendor, or a `modelsEnv`
 * override that removed the only one — and retrying it is pure waste. The
 * second is a bad minute at a vendor, where retrying is the correct response.
 *
 * It also carries what was skipped, so an operator reading a log is told which
 * vendor to add a key for rather than being left to guess.
 */
export class NoVisionLinkError extends Error {
  /** Every link that was skipped, as `provider/model`. */
  readonly blind: string[];

  constructor(blind: string[]) {
    super(
      blind.length === 0
        ? "this request carries an image and the chain is empty"
        : `this request carries an image and no link in the chain can read one (skipped: ${blind.join(", ")})`,
    );
    this.name = "NoVisionLinkError";
    this.blind = blind;
  }
}
