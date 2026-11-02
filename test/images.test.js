import { test } from "node:test";
import assert from "node:assert/strict";
import { generateImage, sniffImageType } from "../dist/images.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]).toString("base64");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("images endpoint returns bytes", async () => {
  const r = await generateImage({
    api: "images",
    apiKey: "k",
    model: "m",
    prompt: "p",
    fetch: async () => json({ data: [{ b64_json: PNG }] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.image.mimeType, "image/png");
});

test("gemini inlineData and openrouter data URI", async () => {
  const g = await generateImage({
    api: "gemini",
    apiKey: "k",
    model: "m",
    prompt: "p",
    fetch: async (url, init) => {
      assert.match(String(url), /:generateContent$/);
      assert.equal(init.headers["x-goog-api-key"], "k");
      return json({
        candidates: [{ content: { parts: [{ text: "x" }, { inlineData: { data: PNG } }] } }],
      });
    },
  });
  assert.equal(g.ok, true);
  const o = await generateImage({
    api: "openrouter-chat",
    apiKey: "k",
    model: "m",
    prompt: "p",
    fetch: async () =>
      json({
        choices: [
          { message: { images: [{ image_url: { url: "data:image/png;base64," + PNG } }] } },
        ],
      }),
  });
  assert.equal(o.ok, true);
});

test("failures are results, not throws", async () => {
  const r = await generateImage({
    api: "images",
    apiKey: "k",
    model: "m",
    prompt: "p",
    fetch: async () => json({ error: { message: "quota" } }, 429),
  });
  assert.deepEqual(r, { ok: false, status: 429, error: "quota" });
  assert.equal(
    (await generateImage({ api: "images", apiKey: "", model: "m", prompt: "p" })).ok,
    false,
  );
  const t = await generateImage({
    api: "images",
    apiKey: "k",
    model: "m",
    prompt: "p",
    fetch: async () => {
      throw new Error("x");
    },
  });
  assert.deepEqual(t, { ok: false, error: "request failed" });
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8])), "image/jpeg");
});
