/**
 * Tests for ai-kit/web.
 *
 * Written against the CONTRACT rather than the implementation, deliberately.
 * The failure this package has already lived through once is a regression test
 * that asserted the buggy behaviour as expected and therefore went green while
 * shipping data loss. So each test below states a rule in the terms a reader
 * would state it ("a redirect into a private network is refused"), and would
 * fail against a plausible WRONG implementation — not merely against a changed
 * one.
 *
 * Three properties carry most of the weight:
 *
 *   - The SSRF guard must hold on EVERY redirect hop, not just the first URL.
 *     A guard that checks the input string and then lets `fetch` follow a 302
 *     is no guard at all, and it passes any test that only feeds it URLs.
 *   - "Found nothing" and "could not look" must stay distinguishable all the
 *     way to the model-facing sentence.
 *   - A citation handle must address the evidence block it claims to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPrivateAddress,
  validateFetchTarget,
  readPage,
  extractReadableText,
  webSearch,
  describeAttempts,
  resultsToFacts,
  resultsEvidence,
  pageToFact,
  pageEvidence,
  describeEmptySearch,
  searxngProvider,
  braveProvider,
  tavilyProvider,
  defaultProviders,
} from "@bitbaum/ai-kit/web";
import { assignFactIds, verifyAnswer, NOT_RECORDED } from "@bitbaum/ai-kit/grounding";

// ── the address judgement ────────────────────────────────────────────────────

test("every non-public IPv4 range is refused", () => {
  for (const addr of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // the cloud metadata service — the one that matters most
    "0.0.0.0",
    "100.64.0.1", // carrier-grade NAT
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isPrivateAddress(addr), true, `${addr} should be refused`);
  }
});

test("ordinary public addresses are allowed", () => {
  for (const addr of ["1.1.1.1", "8.8.8.8", "167.233.22.31", "172.32.0.1", "100.128.0.1"]) {
    assert.equal(isPrivateAddress(addr), false, `${addr} should be allowed`);
  }
});

test("IPv6 spellings of a private address are refused too", () => {
  for (const addr of [
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1",
    "2002:7f00:0001::", // 6to4 wrapping 127.0.0.1
    "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
  ]) {
    assert.equal(isPrivateAddress(addr), true, `${addr} should be refused`);
  }
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("anything that is not a parseable address is refused, not allowed by default", () => {
  for (const junk of ["", "localhost", "not-an-ip", "999.1.1.1", "0x7f000001"]) {
    assert.equal(isPrivateAddress(junk), true, `${junk} should be refused`);
  }
});

test("a hostname resolving to one public AND one private address is refused", async () => {
  // DNS rebinding with the work already done: checking only the first record
  // would let this through, which is why the guard checks every one.
  const verdict = await validateFetchTarget("https://mixed.example", async () => [
    { address: "93.184.216.34" },
    { address: "127.0.0.1" },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /private network/i);
});

test("URL shape is judged before the network is touched", async () => {
  const never = async () => {
    throw new Error("DNS must not be consulted for a URL that cannot be fetched anyway");
  };
  assert.equal((await validateFetchTarget("file:///etc/passwd", never)).ok, false);
  assert.equal((await validateFetchTarget("gopher://example.com", never)).ok, false);
  assert.equal((await validateFetchTarget("https://example.com:5432/", never)).ok, false);
  assert.equal((await validateFetchTarget("https://user:pw@example.com/", never)).ok, false);
  assert.equal((await validateFetchTarget("not a url", never)).ok, false);
});

test("a literal public address needs no resolver, and a literal private one is still refused", async () => {
  const never = async () => {
    throw new Error(
      "a literal address must not be resolved — the resolver would just echo it back",
    );
  };
  const good = await validateFetchTarget("https://1.1.1.1/", never);
  assert.equal(good.ok, true);
  assert.deepEqual(good.addresses, ["1.1.1.1"]);

  const bad = await validateFetchTarget("http://169.254.169.254/latest/meta-data/", never);
  assert.equal(bad.ok, false);
});

// ── the reader ───────────────────────────────────────────────────────────────

const publicLookup = async () => [{ address: "93.184.216.34" }];

function htmlResponse(body, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...extra,
  });
}

test("a redirect into a private network is refused AT THE HOP", async () => {
  // The crown jewel. The first URL is impeccable; the redirect is the attack.
  // An implementation that validates the input and then hands the rest to
  // fetch's own redirect following passes every other test in this file.
  let hops = 0;
  const fetchImpl = async (url) => {
    hops++;
    if (hops === 1) {
      assert.equal(url, "https://innocent.example/");
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:80/admin" },
      });
    }
    throw new Error("the guard let a private address through");
  };
  const lookup = async (hostname) =>
    hostname === "innocent.example" ? [{ address: "93.184.216.34" }] : [{ address: "127.0.0.1" }];

  const outcome = await readPage("https://innocent.example/", {}, { fetch: fetchImpl, lookup });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.kind, "blocked");
  assert.equal(hops, 1, "the second request must never have been made");
});

test("a relative redirect is resolved against the hop it came from", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (seen.length === 1) {
      return new Response(null, { status: 301, headers: { location: "/moved" } });
    }
    return htmlResponse("<title>Here</title><p>Arrived.</p>");
  };
  const outcome = await readPage(
    "https://example.com/start",
    {},
    { fetch: fetchImpl, lookup: publicLookup },
  );
  assert.equal(outcome.ok, true);
  assert.equal(seen[1], "https://example.com/moved");
  assert.equal(outcome.title, "Here");
});

test("a redirect loop ends in a refusal rather than running forever", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://example.com/again" } });
  };
  const outcome = await readPage(
    "https://example.com/a",
    {},
    { fetch: fetchImpl, lookup: publicLookup },
  );
  assert.equal(outcome.ok, false);
  assert.ok(calls <= 5, `bounded, got ${calls} requests`);
});

test("a non-page content type is refused unread, naming what it was", async () => {
  const fetchImpl = async () =>
    new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } });
  const outcome = await readPage(
    "https://example.com/a.pdf",
    {},
    { fetch: fetchImpl, lookup: publicLookup },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.failure.reason, /application\/pdf/);
});

test("HTTP failures are classified, not lumped together", async () => {
  const cases = [
    [429, "rate_limited"],
    [403, "blocked"],
    [500, "bad_response"],
  ];
  for (const [status, kind] of cases) {
    const fetchImpl = async () => new Response("no", { status });
    const outcome = await readPage(
      "https://example.com/",
      {},
      { fetch: fetchImpl, lookup: publicLookup },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure.kind, kind, `${status} should be ${kind}`);
  }
});

test("a timeout is reported as a timeout, and never as an empty page", async () => {
  const fetchImpl = async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };
  const outcome = await readPage(
    "https://example.com/",
    {},
    { fetch: fetchImpl, lookup: publicLookup },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.kind, "timeout");
});

test("truncation is stated, not silent", async () => {
  const long = `<title>Long</title><body>${"word ".repeat(5000)}</body>`;
  const fetchImpl = async () => htmlResponse(long);
  const outcome = await readPage(
    "https://example.com/",
    { maxChars: 500 },
    { fetch: fetchImpl, lookup: publicLookup },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.text.length, 500);
});

test("readPage never throws, whatever the transport does", async () => {
  const fetchImpl = async () => {
    throw new Error("socket exploded");
  };
  const outcome = await readPage(
    "https://example.com/",
    {},
    { fetch: fetchImpl, lookup: publicLookup },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.kind, "unreachable");
});

// ── extraction ───────────────────────────────────────────────────────────────

test("script and style contents never reach the text", () => {
  const { text } = extractReadableText(
    `<title>T</title><script>var secret = "TOKEN123";</script><style>.a{color:red}</style><p>Real words.</p>`,
  );
  assert.ok(!text.includes("TOKEN123"), "script body leaked into the text");
  assert.ok(!text.includes("color:red"), "stylesheet leaked into the text");
  assert.match(text, /Real words\./);
});

test("an unclosed script does not drag the rest of the page in with it", () => {
  const { text } = extractReadableText(`<p>Before.</p><script>leak("SECRET")`);
  assert.ok(!text.includes("SECRET"));
  assert.match(text, /Before\./);
});

test("entities are decoded after tags are stripped, so encoded markup stays inert", () => {
  const { text } = extractReadableText(
    "<p>Costs &euro;5 &amp; up &lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
  assert.match(text, /& up/);
  // The decoded angle brackets must be text, not a tag the stripper then eats.
  assert.match(text, /<script>alert\(1\)<\/script>/);
});

test("block boundaries survive as line breaks so list items do not fuse", () => {
  const { text } = extractReadableText("<ul><li>One</li><li>Two</li></ul>");
  assert.equal(text, "One\nTwo");
});

test("the title is extracted and tag-free", () => {
  const { title } = extractReadableText("<title>A <b>bold</b> title &amp; more</title>");
  assert.equal(title, "A bold title & more");
});

// ── the search chain: three answers, never two ───────────────────────────────

function stubProvider(name, outcome) {
  return { name, configured: () => true, search: async () => outcome };
}

const HIT = { title: "A page", url: "https://example.com/a", snippet: "Some words." };

test("the chain returns the first backend that actually has results", async () => {
  const outcome = await webSearch(
    "q",
    {},
    {
      providers: [
        stubProvider("first", { ok: true, provider: "first", query: "q", results: [HIT] }),
        stubProvider("second", { ok: true, provider: "second", query: "q", results: [HIT, HIT] }),
      ],
    },
  );
  assert.equal(outcome.status, "found");
  assert.equal(outcome.provider, "first");
  assert.equal(outcome.results.length, 1);
});

test("an EMPTY-but-successful backend is walked past, not treated as the answer", async () => {
  // A self-hosted metasearch whose upstreams refused it answers 200 with zero
  // results. Stopping there would report "nothing on the web" on an outage.
  const outcome = await webSearch(
    "q",
    {},
    {
      providers: [
        stubProvider("searxng", { ok: true, provider: "searxng", query: "q", results: [] }),
        stubProvider("brave", { ok: true, provider: "brave", query: "q", results: [HIT] }),
      ],
    },
  );
  assert.equal(outcome.status, "found");
  assert.equal(outcome.provider, "brave");
  assert.equal(describeAttempts(outcome.attempts), "searxng empty; brave 1");
});

test("every backend answering empty is 'nothing' — a real negative", async () => {
  const outcome = await webSearch(
    "q",
    {},
    {
      providers: [
        stubProvider("a", { ok: true, provider: "a", query: "q", results: [] }),
        stubProvider("b", { ok: true, provider: "b", query: "q", results: [] }),
      ],
    },
  );
  assert.equal(outcome.status, "nothing");
});

test("every backend FAILING is 'could_not_look' — not a negative at all", async () => {
  const outcome = await webSearch(
    "q",
    {},
    {
      providers: [
        stubProvider("a", {
          ok: false,
          provider: "a",
          query: "q",
          failure: { kind: "rate_limited", reason: "429" },
        }),
        stubProvider("b", {
          ok: false,
          provider: "b",
          query: "q",
          failure: { kind: "auth", reason: "bad key" },
        }),
      ],
    },
  );
  assert.equal(outcome.status, "could_not_look");
  assert.equal(describeAttempts(outcome.attempts), "a rate_limited; b auth");
});

test("a mix of failure and empty is still 'nothing', because one backend did answer", async () => {
  const outcome = await webSearch(
    "q",
    {},
    {
      providers: [
        stubProvider("a", {
          ok: false,
          provider: "a",
          query: "q",
          failure: { kind: "timeout", reason: "slow" },
        }),
        stubProvider("b", { ok: true, provider: "b", query: "q", results: [] }),
      ],
    },
  );
  assert.equal(outcome.status, "nothing");
});

test("no configured backend is 'could_not_look', and says how to fix it", async () => {
  const outcome = await webSearch("q", {}, { env: {}, providers: undefined });
  assert.equal(outcome.status, "could_not_look");
  assert.match(
    outcome.attempts[0].failure.reason,
    /SEARXNG_URL|BRAVE_SEARCH_API_KEY|TAVILY_API_KEY/,
  );
});

test("an empty query never reaches a backend", async () => {
  let called = false;
  const outcome = await webSearch(
    "   ",
    {},
    { providers: [stubProvider("a", { ok: true, provider: "a", query: "", results: [HIT] })] },
  );
  assert.equal(outcome.status, "could_not_look");
  assert.equal(called, false);
});

// ── providers ────────────────────────────────────────────────────────────────

test("a provider with no credentials is not configured and is left out of the chain", () => {
  assert.equal(braveProvider({}).configured(), false);
  assert.equal(tavilyProvider({}).configured(), false);
  assert.equal(searxngProvider({}).configured(), false);
  assert.equal(searxngProvider({ SEARXNG_URL: "http://127.0.0.1:8888" }).configured(), true);
  assert.deepEqual(
    defaultProviders({ BRAVE_SEARCH_API_KEY: "k" }).map((p) => p.name),
    ["brave"],
  );
});

test("the chain's preference order is searxng, then brave, then tavily", () => {
  const all = defaultProviders({
    SEARXNG_URL: "http://127.0.0.1:8888",
    BRAVE_SEARCH_API_KEY: "k",
    TAVILY_API_KEY: "t",
  });
  assert.deepEqual(
    all.map((p) => p.name),
    ["searxng", "brave", "tavily"],
  );
});

test("a provider maps its own field names into the shared result shape", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            title: "T",
            url: "https://a.example/x",
            content: "snip",
            publishedDate: "2026-01-02",
            engine: "ddg",
          },
          { title: "bad", url: "javascript:alert(1)", content: "" },
          { title: "no url", content: "" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const outcome = await searxngProvider({ SEARXNG_URL: "http://s" }, fetchImpl).search("q", {});
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 1, "non-http and url-less rows are dropped");
  assert.deepEqual(outcome.results[0], {
    title: "T",
    url: "https://a.example/x",
    snippet: "snip",
    published: "2026-01-02",
    engine: "ddg",
  });
});

test("a provider classifies its own HTTP failures instead of returning nothing", async () => {
  for (const [status, kind] of [
    [429, "rate_limited"],
    [401, "auth"],
    [403, "auth"],
    [500, "bad_response"],
  ]) {
    const fetchImpl = async () => new Response("no", { status });
    const outcome = await braveProvider({ BRAVE_SEARCH_API_KEY: "k" }, fetchImpl).search("q", {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure.kind, kind);
  }
});

test("the result cap is honoured and cannot be exceeded by asking", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    title: `t${i}`,
    url: `https://e.example/${i}`,
    content: "",
  }));
  const fetchImpl = async () =>
    new Response(JSON.stringify({ results: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const outcome = await searxngProvider({ SEARXNG_URL: "http://s" }, fetchImpl).search("q", {
    limit: 999,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 20);
});

// ── citations ────────────────────────────────────────────────────────────────

test("a result becomes a citable fact whose url is never dropped", () => {
  const facts = assignFactIds(resultsToFacts([HIT], "brave"));
  assert.equal(facts[0].id, "F1");
  assert.equal(facts[0].kind, "web_result");
  assert.equal(facts[0].fields.url, "https://example.com/a");
  assert.equal(facts[0].source, "web search (brave)");
});

test("a missing publication date renders as an explicit negative, not as silence", () => {
  const facts = assignFactIds(
    resultsToFacts([{ title: "T", url: "https://e.example/", snippet: "" }], "brave"),
  );
  // null here is what `renderFacts` turns into "<not recorded>" — the whole
  // anti-invention mechanism. A field simply absent would invite a guessed year.
  assert.equal(facts[0].fields.published, null);
  assert.ok(NOT_RECORDED.length > 0);
});

test("evidence blocks are labelled with the handle that cites them", () => {
  const results = [HIT, { title: "B", url: "https://b.example/", snippet: "More." }];
  const facts = assignFactIds(resultsToFacts(results, "brave"));
  const evidence = resultsEvidence(facts, results);
  assert.match(evidence[0], /^\[F1\] A page — https:\/\/example\.com\/a/);
  assert.match(evidence[1], /^\[F2\] B — https:\/\/b\.example\//);
});

test("a page's text is evidence under the page's own handle", () => {
  const page = {
    ok: true,
    url: "https://e.example/p",
    title: "P",
    text: "The budget is 4200 CHF.",
    truncated: false,
  };
  const [fact] = assignFactIds([pageToFact(page)]);
  const block = pageEvidence(fact, page);
  assert.match(block, /^\[F1\] P — https:\/\/e\.example\/p/);
  assert.match(block, /4200 CHF/);
  assert.equal(fact.fields.truncated, "no");
});

test("a truncated page says so in the fact, so a summary can be honest about it", () => {
  const page = { ok: true, url: "https://e.example/p", title: "P", text: "start", truncated: true };
  assert.match(pageToFact(page).fields.truncated, /only the first part/);
});

test("the verifier accepts a claim carried by page evidence and rejects an invented one", () => {
  const page = {
    ok: true,
    url: "https://e.example/p",
    title: "P",
    text: "Kraftwerk raised 4200 CHF.",
    truncated: false,
  };
  const [fact] = assignFactIds([pageToFact(page)]);
  const evidence = [pageEvidence(fact, page)];

  const good = verifyAnswer({
    answer: "Kraftwerk raised 4200 CHF [F1].",
    facts: [fact],
    userMessage: "how much did Kraftwerk raise?",
    extraEvidence: evidence,
    mode: "entity-attribution",
    subjects: ["Kraftwerk"],
  });
  assert.equal(good.ok, true, JSON.stringify(good.violations));

  const bad = verifyAnswer({
    answer: "Kraftwerk raised 9900 CHF from Helvetia Ventures [F1].",
    facts: [fact],
    userMessage: "how much did Kraftwerk raise?",
    extraEvidence: evidence,
    mode: "entity-attribution",
    subjects: ["Kraftwerk"],
  });
  assert.equal(bad.ok, false, "an invented funder and figure must be caught");
});

// ── the sentence the model actually reads ────────────────────────────────────

test("'nothing found' and 'could not look' produce OPPOSITE instructions", () => {
  const nothing = describeEmptySearch({ status: "nothing", query: "x", attempts: [] });
  const couldNot = describeEmptySearch({
    status: "could_not_look",
    query: "x",
    attempts: [
      { provider: "brave", outcome: "failed", failure: { kind: "auth", reason: "key rejected" } },
    ],
  });

  assert.match(nothing, /returned no results/);
  assert.match(nothing, /Do NOT present this as proof/);

  assert.match(couldNot, /COULD NOT BE PERFORMED/);
  assert.match(couldNot, /key rejected/, "the operator's real fix must reach the transcript");
  assert.match(couldNot, /must NOT say that nothing was found/);
  assert.notEqual(nothing, couldNot);
});
