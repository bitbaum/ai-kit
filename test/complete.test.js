/**
 * `complete`'s reason to exist: make the call, and make the three judgements
 * every hand-rolled client in this fleet got wrong — an empty 200 is a failure,
 * a daily 429 condemns the vendor, a size 429 ends the walk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { complete, ChainExhaustedError, createHealthTracker } from "@bitbaum/ai-kit";

const ENV = { GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" };

function provider(id, keyEnv, models) {
  return { id, baseUrl: `https://${id}.invalid/v1`, keyEnv, models, dailyTokens: 1000 };
}

/** groq has two models, openrouter one — enough to tell "next model" from "next vendor". */
function chain() {
  const groq = provider("groq", "GROQ_API_KEY", ["big", "small"]);
  const or = provider("openrouter", "OPENROUTER_API_KEY", ["free"]);
  return [
    { provider: groq, model: "big" },
    { provider: groq, model: "small" },
    { provider: or, model: "free" },
  ];
}

/** A fetch that replies per-model from a table, recording what was asked. */
function fakeFetch(table, calls = []) {
  return async (url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    const reply = table[model];
    if (typeof reply === "function") return reply(url, init);
    return reply;
  };
}

function ok(text, toolCalls) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
    }),
    { status: 200 },
  );
}

function err(status, body) {
  return new Response(body, { status });
}

test("returns the first working link and says which one served it", async () => {
  const calls = [];
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ big: ok("hello") }, calls),
  });

  assert.equal(result.text, "hello");
  assert.equal(result.id, "groq/big");
  assert.deepEqual(calls, ["big"]);
});

test("a 200 with empty content is a FAILURE — it demotes instead of returning ''", async () => {
  const calls = [];
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ big: ok(""), small: ok("recovered") }, calls),
  });

  // The bug this prevents: returning "" to the user and reporting success.
  assert.equal(result.text, "recovered");
  assert.deepEqual(calls, ["big", "small"]);
});

test("an empty 200 carrying a tool call is a SUCCESS — no text is normal there", async () => {
  const toolCalls = [{ id: "1", function: { name: "search", arguments: '{"q":"x"}' } }];
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ big: ok("", toolCalls) }),
  });

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "search");
  assert.equal(result.toolCalls[0].args, '{"q":"x"}');
});

test("a DAILY 429 skips the rest of that vendor and jumps to the next one", async () => {
  const calls = [];
  const daily =
    "Rate limit reached ... on tokens per day (TPD): Limit 100000, Used 99331, Requested 4589. Please try again in 56m26.88s";

  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ big: err(429, daily), small: ok("wrong"), free: ok("right") }, calls),
  });

  // groq/small must NOT be tried: same org-wide daily budget, already spent.
  assert.deepEqual(calls, ["big", "free"]);
  assert.equal(result.text, "right");
});

test("a CAPACITY 429 does demote within the same vendor — that budget is per-minute", async () => {
  const calls = [];
  const capacity =
    "Rate limit reached ... on tokens per minute (TPM): Limit 12000, Used 11800, Requested 400. Please try again in 3.6s";

  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ big: err(429, capacity), small: ok("ok") }, calls),
  });

  assert.deepEqual(calls, ["big", "small"]);
  assert.equal(result.id, "groq/small");
});

test("a SIZE 429 ends the walk — the next model down has a SMALLER ceiling", async () => {
  const calls = [];
  const size = "Request too large ... Limit 6000, Requested 15041, please reduce your message size";

  await assert.rejects(
    complete({
      chain: chain(),
      env: ENV,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fakeFetch({ big: err(429, size), small: ok("no"), free: ok("no") }, calls),
    }),
    (e) => e instanceof ChainExhaustedError,
  );

  assert.deepEqual(calls, ["big"]);
});

test("the failure keeps the response BODY — status alone cannot be diagnosed", async () => {
  const daily =
    "Rate limit reached ... tokens per day (TPD): Limit 100000. Please try again in 56m26.88s";

  await assert.rejects(
    complete({
      chain: [chain()[0]],
      env: ENV,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fakeFetch({ big: err(429, daily) }),
    }),
    (e) => {
      assert.match(e.message, /tokens per day/);
      assert.match(e.message, /56m26\.88s/);
      return true;
    },
  );
});

test("a link with no key is skipped and named, not thrown from", async () => {
  const calls = [];
  const result = await complete({
    chain: chain(),
    env: { OPENROUTER_API_KEY: "o" },
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ free: ok("only one with a key") }, calls),
  });

  assert.deepEqual(calls, ["free"]);
  assert.equal(result.id, "openrouter/free");
});

test("every link failing throws ChainExhaustedError carrying ALL of them", async () => {
  await assert.rejects(
    complete({
      chain: chain(),
      env: ENV,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fakeFetch({
        big: err(500, "boom"),
        small: err(404, "model_not_found"),
        free: err(401, "bad key"),
      }),
    }),
    (e) => {
      assert.ok(e instanceof ChainExhaustedError);
      assert.equal(e.failures.length, 3);
      // The 404 is the one that explains a rotted pin; it must survive.
      assert.match(e.message, /model_not_found/);
      return true;
    },
  );
});

test("health records ONE success for the walk even when link one failed", async () => {
  const health = createHealthTracker();
  await complete({
    chain: chain(),
    env: ENV,
    health,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ big: err(500, "boom"), small: ok("fine") }),
  });

  // A working fallback is not a degraded app.
  assert.equal(health.getHealth().status, "ok");
  assert.equal(health.getHealth().consecutiveFailures, 0);
});

test("health records ONE failure for the whole exhausted walk, not one per link", async () => {
  const health = createHealthTracker({ downAfter: 3 });
  await assert.rejects(
    complete({
      chain: chain(),
      env: ENV,
      health,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fakeFetch({ big: err(500, "a"), small: err(500, "b"), free: err(500, "c") }),
    }),
  );

  // Three dead links are one outage. Counting them separately would report
  // "down" after a single failed turn.
  assert.equal(health.getHealth().consecutiveFailures, 1);
  assert.equal(health.getHealth().status, "degraded");
});

test("a transport failure demotes like any other link failure", async () => {
  const calls = [];
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch(
      {
        big: () => {
          throw new Error("ENOTFOUND");
        },
        small: ok("survived"),
      },
      calls,
    ),
  });

  assert.equal(result.text, "survived");
  assert.deepEqual(calls, ["big", "small"]);
});

test("a 200 whose body is not JSON demotes rather than crashing the caller", async () => {
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({
      big: new Response("<html>gateway</html>", { status: 200 }),
      small: ok("json this time"),
    }),
  });

  assert.equal(result.text, "json this time");
});

test("`model` starts the chain at that link instead of the front", async () => {
  const calls = [];
  await complete({
    chain: chain(),
    model: "free",
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch({ free: ok("started here") }, calls),
  });

  assert.deepEqual(calls, ["free"]);
});

test("a REJECTED KEY condemns that vendor — its other models present the same one", async () => {
  const calls = [];
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch(
      {
        big: new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }),
        small: ok("groq's second model — must NOT be reached"),
        free: ok("openrouter answered"),
      },
      calls,
    ),
  });

  // groq/small is skipped: it would send the identical credential and be told
  // the same thing, costing a request to learn nothing. Crossing to OpenRouter
  // still happens — a different key is the whole reason the chain spans
  // vendors.
  assert.equal(result.text, "openrouter answered");
  assert.deepEqual(calls, ["big", "free"]);
});

test("403 counts as rejected too, and 404 does NOT", async () => {
  const forbidden = [];
  await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch(
      {
        big: new Response("forbidden", { status: 403 }),
        small: ok("unreachable"),
        free: ok("openrouter"),
      },
      forbidden,
    ),
  });
  assert.deepEqual(forbidden, ["big", "free"]);

  // A 404 is a RETIRED ID — a fact about one model, answered by asking a
  // different one. Widening the vendor skip to cover it would turn the chain
  // back into the pin it replaced.
  const retired = [];
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch(
      {
        big: new Response('{"error":{"code":"model_not_found"}}', { status: 404 }),
        small: ok("same vendor, next model"),
      },
      retired,
    ),
  });
  assert.equal(result.text, "same vendor, next model");
  assert.deepEqual(retired, ["big", "small"]);
});

test("extraHeaders reach the vendor — attribution a caller loses is invisible", async () => {
  let sent;
  await complete({
    chain: [chain()[0]],
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    extraHeaders: { "HTTP-Referer": "https://botsmann.test", "X-Title": "Botsmann" },
    fetchImpl: async (url, init) => {
      sent = init.headers;
      return ok("hi");
    },
  });

  // OpenRouter reads these for app attribution in its public rankings. An app
  // that stops sending them just disappears from that list, with no error
  // anywhere — so a shared engine that cannot send them is a silent downgrade.
  assert.equal(sent["HTTP-Referer"], "https://botsmann.test");
  assert.equal(sent["X-Title"], "Botsmann");
  assert.equal(sent["content-type"], "application/json");
});

test("extraHeaders can NOT overwrite authorization", async () => {
  let sent;
  await complete({
    chain: [chain()[0]],
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    extraHeaders: { authorization: "Bearer somebody-elses-key" },
    fetchImpl: async (url, init) => {
      sent = init.headers;
      return ok("hi");
    },
  });

  // A typo in a caller's header map must not become an auth failure blamed on
  // the vendor — or, worse, someone else's credential on the wire.
  assert.equal(sent.authorization, "Bearer g");
});

// ─── Deadlines: the failure a fallback chain is least able to survive ────────
//
// A vendor that accepts the connection and then never answers is the most
// common partial outage there is. Without a per-link deadline `await fetch`
// simply never returns, link two is never reached, and the chain that exists
// to survive an outage becomes the thing holding the request open.

/**
 * A wedged vendor: connection accepted, no answer, ever.
 *
 * `deadlines` records whether each link actually received one, and the tests
 * assert on it AFTERWARDS rather than inside. Both details are load-bearing.
 * Without a deadline `init.signal` is undefined, this helper throws instantly,
 * the walk demotes, and a test that only checks "the next link served" passes
 * having proved demotion rather than the deadline it is named for. Asserting
 * in here would not fix that either — `complete` catches everything a link
 * throws, so a failed assertion becomes just another demotion. A test that
 * survives the mutation it claims to cover is not a gate.
 */
function hangs(init, deadlines) {
  deadlines.push(Boolean(init.signal));
  if (!init.signal) return Promise.reject(new Error("no deadline"));
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("This operation was aborted")), {
      once: true,
    });
  });
}

test("a link that never answers is abandoned, and the NEXT link serves", async () => {
  const calls = [];
  const deadlines = [];
  const result = await complete({
    chain: chain(),
    env: ENV,
    timeoutMs: 40,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async (url, init) => {
      const model = JSON.parse(init.body).model;
      calls.push(model);
      if (model === "big") return hangs(init, deadlines);
      return ok("second link answered");
    },
  });

  assert.deepEqual(deadlines, [true], "the hung link must have been given a deadline");
  assert.equal(result.text, "second link answered");
  assert.deepEqual(calls, ["big", "small"]);
});

test("the timeout is PER LINK — a slow first link does not eat the next one's budget", async () => {
  const calls = [];
  const deadlines = [];
  const result = await complete({
    chain: chain(),
    env: ENV,
    timeoutMs: 40,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async (url, init) => {
      const model = JSON.parse(init.body).model;
      calls.push(model);
      if (model === "big" || model === "small") return hangs(init, deadlines);
      // The third link answers only if it got a FRESH budget rather than the
      // remains of a shared one the first two already spent.
      await new Promise((r) => setTimeout(r, 25));
      return ok("third link, own budget");
    },
  });

  assert.deepEqual(deadlines, [true, true], "each hung link must have had its own deadline");
  assert.equal(result.text, "third link, own budget");
  assert.deepEqual(calls, ["big", "small", "free"]);
});

test("a timeout says so, rather than reporting an anonymous abort", async () => {
  const error = await complete({
    chain: [chain()[0]],
    env: ENV,
    timeoutMs: 30,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async (url, init) => hangs(init, []),
  }).then(
    () => null,
    (e) => e,
  );

  assert.ok(error instanceof ChainExhaustedError);
  // "This operation was aborted" in a log is indistinguishable from a caller
  // cancelling, and the two want opposite reactions from whoever reads it.
  assert.match(error.failures[0].message, /no response within 30ms/);
});

test("when the CALLER cancels, the walk stops instead of touring the vendors", async () => {
  const calls = [];
  const controller = new AbortController();

  const error = await complete({
    chain: chain(),
    env: ENV,
    signal: controller.signal,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body).model);
      controller.abort();
      throw new Error("aborted");
    },
  }).then(
    () => null,
    (e) => e,
  );

  assert.ok(error instanceof ChainExhaustedError);
  // The caller is gone. Spending their daily budget on an answer nobody will
  // read — then reporting "every vendor failed" about vendors never asked — is
  // worse than useless.
  assert.deepEqual(calls, ["big"]);
});

test("timeoutMs: 0 means wait forever — the escape hatch is real, not decorative", async () => {
  const result = await complete({
    chain: [chain()[0]],
    env: ENV,
    timeoutMs: 0,
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async (url, init) => {
      // No deadline of ours means no composed signal imposed on the link.
      assert.equal(init.signal, undefined);
      return ok("waited");
    },
  });

  assert.equal(result.text, "waited");
});

// ── The quota hook ──────────────────────────────────────────────────────────
// A hook nobody calls is a dead feature that looks alive, so these assert the
// WIRING. The parsing itself is meter.test.js's job.

test("quota headers on a SUCCESS reach the caller's sink", async () => {
  const seen = [];
  await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    onQuota: (readings) => seen.push(...readings),
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), {
        status: 200,
        headers: {
          "x-ratelimit-limit-requests": "1000",
          "x-ratelimit-remaining-requests": "998",
        },
      }),
  });

  assert.equal(seen.length, 1, "the successful call disclosed one counter");
  assert.equal(seen[0].remaining, 998);
  assert.equal(seen[0].provider, "groq");
});

test("a REFUSAL reports an empty tank — the most reliable reading there is", async () => {
  const daily = "Rate limit reached on tokens per day (TPD): Limit 100000. Try again in 56m26.88s.";
  const seen = [];
  await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    onQuota: (readings) => seen.push(...readings),
    fetchImpl: fakeFetch({ big: err(429, daily), small: ok("x"), free: ok("x") }),
  });

  const empty = seen.filter((r) => r.remaining === 0 && r.source === "429");
  assert.ok(empty.length >= 1, "the 429 was recorded as a zero, correcting any local counter");
  assert.equal(empty[0].provider, "groq");
});

test("a SIZE refusal does NOT report an empty tank", async () => {
  // "Request too large" means this one prompt did not fit, not that the
  // allowance is gone. Recording it as empty would take a working vendor out of
  // service for the rest of the day over one oversized prompt.
  const size =
    "Request too large for model on tokens per minute (TPM): Limit 6000, Requested 15041";
  const seen = [];
  await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    onQuota: (readings) => seen.push(...readings),
    fetchImpl: fakeFetch({ big: err(429, size), small: ok("x"), free: ok("x") }),
  }).catch(() => {});

  assert.equal(
    seen.filter((r) => r.source === "429").length,
    0,
    "a size refusal says nothing about the allowance",
  );
});

test("a throwing sink cannot turn a good answer into a failure", async () => {
  // The hook runs inside the response path. An app's logging bug must not
  // become a vendor outage.
  const result = await complete({
    chain: chain(),
    env: ENV,
    messages: [{ role: "user", content: "hi" }],
    onQuota: () => {
      throw new Error("the app's sink is broken");
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "survived" } }] }), {
        status: 200,
        headers: { "x-ratelimit-remaining-requests": "5" },
      }),
  });

  assert.equal(result.text, "survived");
});
