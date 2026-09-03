/**
 * `tryChain`'s entire reason to exist: try the next link on failure, instead
 * of stopping at the first one — and never own the actual request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { tryChain, ChainExhaustedError, createHealthTracker } from "@bitbaum/ai-kit";

function link(providerId, model) {
  return {
    provider: {
      id: providerId,
      baseUrl: "https://example.invalid",
      keyEnv: "X",
      models: [model],
      dailyTokens: 0,
    },
    model,
  };
}

test("returns the first link's result without trying the rest", async () => {
  const tried = [];
  const result = await tryChain([link("groq", "a"), link("openrouter", "b")], {
    attempt: async (l) => {
      tried.push(l.model);
      return `ok:${l.model}`;
    },
  });
  assert.equal(result, "ok:a");
  assert.deepEqual(tried, ["a"]);
});

test("demotes to the next link on failure — the whole point of a chain", async () => {
  const tried = [];
  const result = await tryChain([link("groq", "dead"), link("openrouter", "alive")], {
    attempt: async (l) => {
      tried.push(l.model);
      if (l.model === "dead") throw new Error("401 unauthorized");
      return `ok:${l.model}`;
    },
  });
  assert.equal(result, "ok:alive");
  assert.deepEqual(tried, ["dead", "alive"]);
});

test("every link failing throws ChainExhaustedError naming every failure, not just the last", async () => {
  await assert.rejects(
    tryChain([link("groq", "a"), link("openrouter", "b")], {
      attempt: async (l) => {
        throw new Error(`${l.model} refused`);
      },
    }),
    (err) => {
      assert.ok(err instanceof ChainExhaustedError);
      assert.equal(err.failures.length, 2);
      assert.match(err.message, /a refused/);
      assert.match(err.message, /b refused/);
      return true;
    },
  );
});

test('an empty chain is a distinct, honest failure — not silently "succeeds with nothing"', async () => {
  await assert.rejects(tryChain([], { attempt: async () => "unreachable" }), (err) => {
    assert.ok(err instanceof ChainExhaustedError);
    assert.match(err.message, /no key|No usable link/i);
    return true;
  });
});

test("a success on link two still records a SUCCESS, not degraded — the fallback working is not a problem", async () => {
  const health = createHealthTracker();
  await tryChain([link("groq", "dead"), link("openrouter", "alive")], {
    health,
    attempt: async (l) => {
      if (l.model === "dead") throw new Error("401");
      return "ok";
    },
  });
  assert.equal(health.getHealth().status, "ok");
  assert.equal(health.getHealth().consecutiveFailures, 0);
});

test("exhausting the chain records exactly ONE failure on the tracker, not one per link", async () => {
  const health = createHealthTracker({ downAfter: 2 });
  await assert.rejects(
    tryChain([link("groq", "a"), link("openrouter", "b")], {
      health,
      attempt: async () => {
        throw new Error("down");
      },
    }),
  );
  assert.equal(
    health.getHealth().consecutiveFailures,
    1,
    "one exhausted walk is one data point, not two",
  );
});

test("onLinkFailure fires per demoted link, for callers that want to log each attempt", async () => {
  const seen = [];
  await tryChain([link("groq", "a"), link("openrouter", "b")], {
    onLinkFailure: (l, err) => seen.push(`${l.provider.id}:${err.message}`),
    attempt: async (l) => {
      if (l.provider.id === "groq") throw new Error("boom");
      return "ok";
    },
  });
  assert.deepEqual(seen, ["groq:boom"]);
});
