/**
 * `transcribe`'s reason to exist: the fleet's three hand-rolled transcription
 * clients each had one vendor and one key, so a blip took dictation down with
 * no fallback and a different error message per app.
 *
 * These assert that it borrows the SAME routing judgements `complete` makes —
 * because the point of putting it here was that there is one answer to "is
 * this vendor dead", not two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { transcribe, ChainExhaustedError, createHealthTracker } from "@bitbaum/ai-kit";

const ENV = { GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" };

function provider(id, keyEnv, models) {
  return { id, baseUrl: `https://${id}.invalid/v1`, keyEnv, models, dailyTokens: 1000 };
}

function chain() {
  const groq = provider("groq", "GROQ_API_KEY", ["whisper-big", "whisper-small"]);
  const or = provider("openrouter", "OPENROUTER_API_KEY", ["whisper-free"]);
  return [
    { provider: groq, model: "whisper-big" },
    { provider: groq, model: "whisper-small" },
    { provider: or, model: "whisper-free" },
  ];
}

const audio = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });

function ok(text) {
  return new Response(JSON.stringify({ text }), { status: 200 });
}

test("the first link that works answers, and says which one did", async () => {
  const result = await transcribe({
    audio: audio(),
    chain: chain(),
    env: ENV,
    fetchImpl: async () => ok("chunnsch au no verbi"),
  });

  assert.equal(result.text, "chunnsch au no verbi");
  assert.equal(result.id, "groq/whisper-big");
});

test("a dead vendor steps aside for the next one", async () => {
  // The whole reason this is not a single-vendor fetch.
  const seen = [];
  const result = await transcribe({
    audio: audio(),
    chain: chain(),
    env: ENV,
    fetchImpl: async (url) => {
      seen.push(new URL(url).host);
      if (seen.length === 1) return new Response("upstream on fire", { status: 503 });
      return ok("second time lucky");
    },
  });

  assert.equal(result.text, "second time lucky");
  assert.equal(result.id, "groq/whisper-small");
});

test("a DAILY 429 condemns the whole vendor, a busy minute does not", async () => {
  // The judgement `complete` makes, made here by the same function rather than
  // by a second copy that could disagree with it.
  const tried = [];
  await assert.rejects(
    transcribe({
      audio: audio(),
      chain: chain(),
      env: ENV,
      fetchImpl: async (url, init) => {
        tried.push(init.body.get("model"));
        return new Response("Rate limit reached for model on tokens per day (TPD)", {
          status: 429,
        });
      },
    }),
    ChainExhaustedError,
  );

  // groq's second model is skipped: it draws on the same exhausted daily budget.
  assert.deepEqual(tried, ["whisper-big", "whisper-free"]);
});

test("the audio goes as multipart, with the model and the language", async () => {
  let body;
  await transcribe({
    audio: audio(),
    filename: "dictation.webm",
    language: "de",
    chain: chain(),
    env: ENV,
    fetchImpl: async (_url, init) => {
      body = init.body;
      return ok("guet");
    },
  });

  assert.ok(body instanceof FormData);
  assert.equal(body.get("model"), "whisper-big");
  assert.equal(body.get("language"), "de");
  assert.equal(body.get("file").name, "dictation.webm");
});

test("no content-type is set by hand", async () => {
  // `fetch` writes it from the FormData, including the multipart boundary.
  // Setting it manually omits the boundary and every vendor answers 400.
  let headers;
  await transcribe({
    audio: audio(),
    chain: chain(),
    env: ENV,
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return ok("x");
    },
  });

  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("content-type"));
  assert.equal(headers.authorization, "Bearer g");
});

test("it posts to the transcription endpoint, not the chat one", async () => {
  let url;
  await transcribe({
    audio: audio(),
    chain: chain(),
    env: ENV,
    fetchImpl: async (u) => {
      url = u;
      return ok("x");
    },
  });
  assert.equal(url, "https://groq.invalid/v1/audio/transcriptions");
});

test("an EMPTY transcript is an answer, not a failure", async () => {
  // Silence really does transcribe to nothing. Demoting it would re-upload the
  // same audio to every vendor in the chain to be told the same true thing.
  let calls = 0;
  const result = await transcribe({
    audio: audio(),
    chain: chain(),
    env: ENV,
    fetchImpl: async () => {
      calls += 1;
      return ok("");
    },
  });

  assert.equal(result.text, "");
  assert.equal(calls, 1, "an empty transcript must not walk the chain");
});

test("a 200 carrying no text field IS a failure", async () => {
  // A success code over a body that is not a transcript is an outage wearing
  // the wrong clothes — the same call `complete` makes about empty content.
  let calls = 0;
  await assert.rejects(
    transcribe({
      audio: audio(),
      chain: chain(),
      env: ENV,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "nope" }), { status: 200 });
      },
    }),
    ChainExhaustedError,
  );
  assert.equal(calls, 3, "every link should have been tried");
});

test("a missing key skips the vendor rather than failing the call", async () => {
  const result = await transcribe({
    audio: audio(),
    chain: chain(),
    env: { OPENROUTER_API_KEY: "o" },
    fetchImpl: async () => ok("from openrouter"),
  });
  assert.equal(result.id, "openrouter/whisper-free");
});

test("health records the outcome, so a dashboard can see it", async () => {
  const health = createHealthTracker();
  await transcribe({
    audio: audio(),
    chain: chain(),
    env: ENV,
    health,
    fetchImpl: async () => ok("hi"),
  });

  await assert.rejects(
    transcribe({
      audio: audio(),
      chain: chain(),
      env: ENV,
      health,
      fetchImpl: async () => new Response("down", { status: 500 }),
    }),
    ChainExhaustedError,
  );

  const after = health.getHealth();
  assert.equal(after.consecutiveFailures, 1, "the exhausted chain counts once, not once per link");
  assert.ok(after.lastSuccessAt !== null, "the earlier success was recorded");
  assert.ok(after.lastError?.includes("500"), "and the reason survives for whoever reads it");
});

test("every failure is reported, not only the last", async () => {
  // The failure that explains an outage is usually not the final one.
  const error = await transcribe({
    audio: audio(),
    chain: chain(),
    env: ENV,
    fetchImpl: async () => new Response("nope", { status: 500 }),
  }).catch((e) => e);

  assert.ok(error instanceof ChainExhaustedError);
  assert.equal(error.failures.length, 3);
});
