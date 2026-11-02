/**
 * Image generation, one transport for the fleet.
 *
 * WHY HERE. OrangeCat had its own client (src/services/images/generate.ts)
 * and BiasLens needed the same thing. Model/provider transport belongs to
 * ai-kit, so the request shapes live here once: OpenAI-style
 * `/images/generations`, OpenRouter chat with image output, and Gemini
 * `generateContent` with an image part. Keys and models are the caller's;
 * nothing here reads the environment or names a default model.
 *
 * Never throws: every failure is a result with a short, user-safe reason.
 */

export type ImageApi = "images" | "openrouter-chat" | "gemini";

export interface GenerateImageOptions {
  api: ImageApi;
  apiKey: string;
  model: string;
  prompt: string;
  /** Defaults: images → https://api.openai.com/v1, openrouter-chat → https://openrouter.ai/api/v1, gemini → https://generativelanguage.googleapis.com/v1beta. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export type GenerateImageResult =
  { ok: true; image: GeneratedImage } | { ok: false; error: string; status?: number };

const DEFAULT_BASE: Record<ImageApi, string> = {
  images: "https://api.openai.com/v1",
  "openrouter-chat": "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

/** Reads the format from the bytes; providers do not always say. */
export function sniffImageType(bytes: Uint8Array): GeneratedImage["mimeType"] {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  return "image/png";
}

const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

const fromDataUri = (uri: string): Uint8Array | null => {
  const m = /^data:image\/[a-z]+;base64,(.+)$/i.exec(uri);
  return m ? fromBase64(m[1]!) : null;
};

const ok = (bytes: Uint8Array): GenerateImageResult => ({
  ok: true,
  image: { bytes, mimeType: sniffImageType(bytes) },
});

export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const doFetch = options.fetch ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE[options.api]).replace(/\/$/, "");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 90_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 90_000);
  if (!options.apiKey) return { ok: false, error: "no key configured" };
  if (!options.prompt.trim()) return { ok: false, error: "empty prompt" };
  try {
    let response: Response;
    if (options.api === "gemini") {
      response = await doFetch(
        `${base}/models/${encodeURIComponent(options.model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: options.prompt }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
          }),
          signal,
        },
      );
    } else if (options.api === "openrouter-chat") {
      response = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: options.model,
          modalities: ["image", "text"],
          messages: [{ role: "user", content: options.prompt }],
        }),
        signal,
      });
    } else {
      response = await doFetch(`${base}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: options.model, prompt: options.prompt, n: 1 }),
        signal,
      });
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return {
        ok: false,
        status: response.status,
        error: (body?.error?.message ?? `provider returned ${response.status}`).slice(0, 300),
      };
    }
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (options.api === "gemini") {
      const parts =
        (json as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] })
          ?.candidates?.[0]?.content?.parts ?? [];
      const data = parts.find((p) => p.inlineData?.data)?.inlineData?.data;
      return data ? ok(fromBase64(data)) : { ok: false, error: "provider returned no image" };
    }
    if (options.api === "openrouter-chat") {
      const images =
        (json as { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[] })
          ?.choices?.[0]?.message?.images ?? [];
      const bytes = images.map((i) => fromDataUri(i.image_url?.url ?? "")).find(Boolean);
      return bytes ? ok(bytes) : { ok: false, error: "provider returned no image" };
    }
    const first = (json as { data?: { b64_json?: string; url?: string }[] })?.data?.[0];
    if (first?.b64_json) return ok(fromBase64(first.b64_json));
    if (first?.url?.startsWith("https://")) {
      const download = await doFetch(first.url, { signal });
      if (!download.ok) return { ok: false, error: "could not download the generated image" };
      return ok(new Uint8Array(await download.arrayBuffer()));
    }
    return { ok: false, error: "provider returned no image" };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, error: timedOut ? "generation timed out" : "request failed" };
  }
}
