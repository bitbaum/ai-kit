import { test } from "node:test";
import assert from "node:assert/strict";
import { readEventStream, sseEvent, sseResponse } from "../dist/sse.js";

const encoder = new TextEncoder();
async function read(text, split = 1) {
  const bytes = encoder.encode(text);
  const events = [];
  await readEventStream(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
        controller.close();
      },
    }),
    (event) => events.push(event),
  );
  return events;
}

test("JSON frames survive every byte boundary, including Unicode", async () => {
  const values = [{ text: "Grüezi 👋" }, { done: true }];
  for (let split = 1; split < 32; split++)
    assert.deepEqual(await read(values.map(sseEvent).join(""), split), values);
});

test("multiline data, metadata and every SSE line delimiter", async () => {
  for (const separator of ["\n", "\r", "\r\n"])
    assert.deepEqual(
      await read(
        [": ping", "event: answer", "id: 7", 'data: {"text":', 'data: "hello"}', "", ""].join(
          separator,
        ),
      ),
      [{ text: "hello" }],
    );
});

test("malformed frames and sentinels do not discard the next answer", async () => {
  assert.deepEqual(await read("data: nope\n\ndata: [DONE]\n\n" + sseEvent({ ok: true })), [
    { ok: true },
  ]);
  assert.deepEqual(await read('data: {"incomplete":true}\n'), []);
  assert.deepEqual(await read('data: {"incomplete":true}'), []);
});

test("a callback failure cancels the source and preserves the original error", async () => {
  const failure = new Error("stop this turn");
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseEvent({ text: "hello" })));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readEventStream(body, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("shared emitter and reader round trip", async () => {
  const response = sseResponse(async (emit) => {
    emit({ text: "hello" });
    emit({ done: true });
  });
  const events = [];
  await readEventStream(response.body, (event) => events.push(event));
  assert.deepEqual(events, [{ text: "hello" }, { done: true }]);
});
