/**
 * `completeStream`'s reasons to exist, one test each:
 *
 *  1. the chunk-boundary bug that motivated the whole thing — an SSE frame
 *     split across two network chunks must not be dropped
 *  2. the chain still walks, with the same verdicts complete() reaches
 *  3. fallback stops the instant the reader has seen output, and says so
 *
 * The transport is a fake `fetch` returning a ReadableStream whose chunk
 * boundaries this file CHOOSES, because the boundaries are the bug. Real
 * vendors put them wherever TCP does, which is why two apps shipped a reader
 * that worked in every test they wrote and lost words in production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { completeStream, sseFrames, StreamInterrupted, ChainExhaustedError } from "@bitbaum/ai-kit";

const provider = (id) => ({
  id,
  baseUrl: `https://${id}.invalid`,
  keyEnv: `${id.toUpperCase()}_KEY`,
  models: ["m"],
  dailyTokens: 0,
});
const link = (id) => ({ provider: provider(id), model: "m" });
const env = { GROQ_KEY: "k1", OPENROUTER_KEY: "k2" };

/** An OpenAI-shaped text chunk. */
const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

/** A body that hands back exactly these byte slices, in order. */
function bodyOf(slices) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= slices.length) return c.close();
      c.enqueue(enc.encode(slices[i++]));
    },
  });
}

const okStream = (slices) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  body: bodyOf(slices),
  text: async () => "",
});

async function collect(gen) {
  const out = [];
  for await (const d of gen) out.push(d);
  return out;
}

// --------------------------------------------------------- the actual bug --

test("a frame split across two chunks is not dropped", async () => {
  // "Hello world" arrives as one SSE frame, cut in half mid-JSON. A reader
  // that splits each chunk on newlines and keeps no remainder loses it
  // entirely — and this is the common case under load, not an edge case.
  const whole = chunk("Hello world");
  const cut = Math.floor(whole.length / 2);

  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq")],
      env,
      fetchImpl: async () => okStream([whole.slice(0, cut), whole.slice(cut)]),
    }),
  );

  const text = deltas
    .filter((d) => d.type === "text")
    .map((d) => d.text)
    .join("");
  assert.equal(text, "Hello world");
  assert.equal(deltas.at(-1).type, "end");
  assert.equal(deltas.at(-1).text, "Hello world");
});

test("sseFrames holds the remainder rather than parsing half a line", () => {
  const first = sseFrames('data: {"a":1}\ndata: {"b":2');
  assert.deepEqual(first.frames, ['{"a":1}']);
  assert.equal(first.rest, 'data: {"b":2');

  const second = sseFrames(first.rest + "}\n");
  assert.deepEqual(second.frames, ['{"b":2}']);
  assert.equal(second.rest, "");
});

test("comments, blank lines and [DONE] are skipped, not parsed", () => {
  const { frames } = sseFrames(': keepalive\n\nevent: ping\ndata: [DONE]\ndata: {"x":1}\n');
  assert.deepEqual(frames, ['{"x":1}']);
});

test("a chunk splitting a multi-byte character does not produce U+FFFD", async () => {
  const whole = chunk("Zürich");
  const bytes = new TextEncoder().encode(whole);
  // Cut inside the two-byte "ü".
  const at = whole.indexOf("ü") + 1;
  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq")],
      env,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "",
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes.slice(0, at));
            c.enqueue(bytes.slice(at));
            c.close();
          },
        }),
      }),
    }),
  );
  assert.equal(deltas.at(-1).text, "Zürich");
});

// ------------------------------------------------------------- the chain --

test("a link that 429s before any output demotes, and the next one serves", async () => {
  const tried = [];
  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq"), link("openrouter")],
      env,
      fetchImpl: async (url) => {
        tried.push(url);
        if (url.startsWith("https://groq.")) {
          return {
            ok: false,
            status: 429,
            headers: new Headers(),
            text: async () => "rate limit reached for requests per day",
          };
        }
        return okStream([chunk("from the second link")]);
      },
    }),
  );

  assert.equal(tried.length, 2, "it walked past the refused link");
  assert.equal(deltas.at(-1).text, "from the second link");
  assert.equal(deltas.at(-1).id, "openrouter/m");
});

test("a 200 that streams nothing is a dead link, not a served turn", async () => {
  // The streaming twin of complete()'s "200 with empty content" rule. Without
  // it every vendor that accepts the request and then says nothing looks like
  // a success, and the chain never gets its chance.
  const tried = [];
  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq"), link("openrouter")],
      env,
      fetchImpl: async (url) => {
        tried.push(url);
        if (url.startsWith("https://groq.")) return okStream(["\n\n"]);
        return okStream([chunk("real answer")]);
      },
    }),
  );
  assert.equal(tried.length, 2);
  assert.equal(deltas.at(-1).text, "real answer");
});

test("no link produces a first token -> ChainExhaustedError naming every one", async () => {
  await assert.rejects(
    () =>
      collect(
        completeStream({
          messages: [{ role: "user", content: "hi" }],
          chain: [link("groq"), link("openrouter")],
          env,
          fetchImpl: async () => ({
            ok: false,
            status: 500,
            headers: new Headers(),
            text: async () => "upstream is unwell",
          }),
        }),
      ),
    (err) => {
      assert.ok(err instanceof ChainExhaustedError);
      assert.equal(err.failures.length, 2, "both links are reported, not just the last");
      return true;
    },
  );
});

test("a link with no key in env is skipped without a request", async () => {
  let calls = 0;
  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq"), link("openrouter")],
      env: { OPENROUTER_KEY: "k2" },
      fetchImpl: async () => {
        calls++;
        return okStream([chunk("ok")]);
      },
    }),
  );
  assert.equal(calls, 1, "the keyless link cost no round trip");
  assert.equal(deltas.at(-1).id, "openrouter/m");
});

// ------------------------------------------- where the fallback has to stop --

test("a stream that breaks AFTER output throws StreamInterrupted, and does not retry", async () => {
  // This is the line between complete() and completeStream(). Retrying here
  // would replay the answer from the beginning into a reader who has already
  // seen the first half.
  let calls = 0;
  await assert.rejects(
    () =>
      collect(
        completeStream({
          messages: [{ role: "user", content: "hi" }],
          chain: [link("groq"), link("openrouter")],
          env,
          fetchImpl: async () => {
            calls++;
            const enc = new TextEncoder();
            let sent = false;
            return {
              ok: true,
              status: 200,
              headers: new Headers(),
              text: async () => "",
              body: new ReadableStream({
                pull(c) {
                  if (!sent) {
                    sent = true;
                    return c.enqueue(enc.encode(chunk("half an ans")));
                  }
                  c.error(new Error("connection reset"));
                },
              }),
            };
          },
        }),
      ),
    (err) => {
      assert.ok(err instanceof StreamInterrupted, "not a ChainExhaustedError");
      assert.equal(err.partial, "half an ans", "it reports what the reader already saw");
      assert.match(err.message, /already seen/);
      return true;
    },
  );
  assert.equal(calls, 1, "the second link was never tried — that would duplicate the answer");
});

// ------------------------------------------------------------ tool calls --

test("tool-call fragments are assembled across chunks", async () => {
  const frag = (o) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [o] } }] })}\n\n`;
  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq")],
      env,
      fetchImpl: async () =>
        okStream([
          frag({ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"q":' } }),
          frag({ index: 0, function: { arguments: '"zurich"}' } }),
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        ]),
    }),
  );

  const end = deltas.at(-1);
  assert.equal(end.type, "end");
  assert.equal(end.toolCalls.length, 1);
  assert.equal(end.toolCalls[0].name, "lookup");
  assert.equal(end.toolCalls[0].args, '{"q":"zurich"}', "arguments are concatenated, not replaced");
  assert.equal(JSON.parse(end.toolCalls[0].args).q, "zurich");
  assert.equal(end.finishReason, "tool_calls");
});

test("the request asks for a stream and carries the key last", async () => {
  let seen;
  await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq")],
      env,
      // A caller must not be able to override the credential with a typo.
      extraHeaders: { authorization: "Bearer WRONG", "x-app": "test" },
      fetchImpl: async (_url, init) => {
        seen = init;
        return okStream([chunk("ok")]);
      },
    }),
  );
  assert.equal(JSON.parse(seen.body).stream, true);
  assert.equal(seen.headers.authorization, "Bearer k1");
  assert.equal(seen.headers["x-app"], "test", "other caller headers survive");
});

test("health records a success only once the turn actually completes", async () => {
  const seen = [];
  const health = { recordSuccess: () => seen.push("ok"), recordFailure: () => seen.push("fail") };
  await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq")],
      env,
      health,
      fetchImpl: async () => okStream([chunk("done")]),
    }),
  );
  assert.deepEqual(seen, ["ok", "ok"], "walk success plus turn success");
});

// ------------------------------------------------ first-token deadline --

/** A body that sends nothing until the request is aborted — a link thinking silently, or hung. */
function silentBody(signal) {
  return new ReadableStream({
    start(c) {
      signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
    },
  });
}

test("a link with no first token by firstTokenMs is left for the next one", async () => {
  const started = Date.now();
  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq"), link("openrouter")],
      env,
      firstTokenMs: 50,
      timeoutMs: 10_000,
      fetchImpl: async (url, init) =>
        String(url).includes("groq")
          ? { ok: true, status: 200, headers: new Headers(), body: silentBody(init.signal) }
          : okStream([chunk("from the next link")]),
    }),
  );
  assert.ok(Date.now() - started < 2_000, "did not wait for the whole-stream timeout");
  const end = deltas.at(-1);
  assert.equal(end.text, "from the next link");
});

test("once the first token is out, a slow stream is not cut by firstTokenMs", async () => {
  const enc = new TextEncoder();
  let i = 0;
  const slices = [chunk("one "), chunk("two")];
  const slow = new ReadableStream({
    async pull(c) {
      if (i >= slices.length) return c.close();
      if (i > 0) await new Promise((r) => setTimeout(r, 120));
      c.enqueue(enc.encode(slices[i++]));
    },
  });
  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq"), link("openrouter")],
      env,
      firstTokenMs: 50,
      fetchImpl: async (url) =>
        String(url).includes("groq")
          ? { ok: true, status: 200, headers: new Headers(), body: slow }
          : okStream([chunk("wrong link")]),
    }),
  );
  assert.equal(deltas.at(-1).text, "one two");
});

test("the last link is never cut by firstTokenMs — a slow answer beats none", async () => {
  const enc = new TextEncoder();
  const late = new ReadableStream({
    async start(c) {
      await new Promise((r) => setTimeout(r, 120));
      c.enqueue(enc.encode(chunk("late but here")));
      c.close();
    },
  });
  const deltas = await collect(
    completeStream({
      messages: [{ role: "user", content: "hi" }],
      chain: [link("groq")],
      env,
      firstTokenMs: 50,
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: late }),
    }),
  );
  assert.equal(deltas.at(-1).text, "late but here");
});
