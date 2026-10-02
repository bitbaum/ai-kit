/**
 * Where dictation goes, and what to throw away when it comes back.
 *
 * Every app with a microphone was writing these two things itself: Heidi has
 * a Groq Whisper chain and a silence denylist in its own lib, Loki has copies,
 * and Substrata had none — so its microphone had no server leg at all. This is
 * the one definition, like `freeChain` is for text.
 *
 * NOT the chat chain. Those models answer questions; these transcribe audio,
 * and pointing one at the other's endpoint produces a 404 per link and a
 * confident report that every vendor is down.
 */
import type { Link, Provider } from "./chain.js";

const GROQ_SPEECH: Provider = {
  id: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  keyEnv: "GROQ_API_KEY",
  // `turbo` first: measured as strong on German and the cheapest option that
  // is (Heidi, 2026-09); the full model is the fallback when turbo rots.
  models: ["whisper-large-v3-turbo", "whisper-large-v3"],
  // Billed by audio seconds, not tokens: it draws on no token pool that
  // fair-share rations, so it claims none.
  dailyTokens: 0,
};

/** The links `transcribe()` should try, in order. */
export function speechChain(): Link[] {
  return GROQ_SPEECH.models.map((model) => ({
    provider: { ...GROQ_SPEECH, models: [...GROQ_SPEECH.models] },
    model,
  }));
}

/** Whether this deployment can transcribe at all (its speech key is set). */
export function speechConfigured(env: Record<string, string | undefined> = {}): boolean {
  return Boolean(env[GROQ_SPEECH.keyEnv]?.trim());
}

/**
 * What a speech model returns when it hears nothing. Whisper does not answer
 * "silence": it answers with the likeliest sentence given no evidence — a
 * broadcast subtitle credit for German, a politeness for English. Measured on
 * Heidi's endpoint: a pure tone came back "Amen.", synthetic silence
 * "Untertitelung des ZDF, 2020". Left alone, a muted microphone types words
 * the person never said into their message.
 *
 * Exact matches only, after normalising: a substring rule would eat "Vielen
 * Dank für Ihre Hilfe, können Sie …", which is a real thing to dictate.
 */
const SILENCE_ARTEFACTS = new Set([
  "untertitelung des zdf",
  "untertitel im auftrag des zdf",
  "untertitel von stephanie geiges",
  "untertitelung im auftrag des zdf",
  "vielen dank",
  "vielen dank fürs zuschauen",
  "vielen dank für die aufmerksamkeit",
  "thank you",
  "thanks for watching",
  "you",
  "bye",
  "amen",
  "musik",
  "music",
  "applaus",
  "applause",
  "copyright wdr",
]);

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9]/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when a transcript is the model's silence artefact rather than speech. */
export function looksLikeSilence(text: string): boolean {
  const t = normalise(text);
  return t === "" || SILENCE_ARTEFACTS.has(t);
}
