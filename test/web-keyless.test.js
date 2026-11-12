/**
 * Keyless backends (ai-kit/web keyless.ts), held to the same contract as the
 * rest of the web module: a partial index answering empty is never "nothing on
 * the web", GDELT is never asked faster than it allows, and each backend maps
 * its own fields into the shared result without inventing a date.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  webSearch,
  describeAttempts,
  gdeltProvider,
  wikipediaProvider,
  keylessProviders,
  withKeylessFallback,
} from "@bitbaum/ai-kit/web";
import { gdeltQuery, resetGdeltPacing } from "../dist/web/keyless.js";

const HIT = { title: "T", url: "https://example.org/a", snippet: "" };

function stub(name, outcome, coverage) {
  return { name, coverage, configured: () => true, search: async () => outcome };
}
const failed = (name) =>
  stub(name, {
    ok: false,
    provider: name,
    query: "q",
    failure: { kind: "unreachable", reason: "down" },
  });
const empty = (name, coverage) =>
  stub(name, { ok: true, provider: name, query: "q", results: [] }, coverage);

test("a partial index answering empty after the web failed is still 'could not look'", async () => {
  const outcome = await webSearch(
    "q",
    {},
    { providers: [failed("searxng"), empty("gdelt", "partial")] },
  );
  assert.equal(outcome.status, "could_not_look");
  assert.equal(describeAttempts(outcome.attempts), "searxng unreachable; gdelt empty");
});

test("a web backend answering empty is still a real negative, whatever partial ones say", async () => {
  const outcome = await webSearch(
    "q",
    {},
    { providers: [empty("brave"), empty("gdelt", "partial")] },
  );
  assert.equal(outcome.status, "nothing");
});

test("a partial index's results are results", async () => {
  const outcome = await webSearch(
    "q",
    {},
    {
      providers: [
        failed("searxng"),
        stub("gdelt", { ok: true, provider: "gdelt", query: "q", results: [HIT] }, "partial"),
      ],
    },
  );
  assert.equal(outcome.status, "found");
  assert.equal(outcome.provider, "gdelt");
});

test("GDELT's query drops words it would refuse as too short, keeps phrases, maps site and language", () => {
  assert.equal(gdeltQuery("is helium in short supply"), "helium short supply");
  assert.equal(gdeltQuery('"rare earth" export of ga'), '"rare earth" export');
  assert.equal(
    gdeltQuery("gallium", { site: "https://www.reuters.com/x", lang: "en-GB" }),
    "gallium domain:www.reuters.com sourcelang:english",
  );
  assert.equal(gdeltQuery("gallium", { lang: "xx" }), "gallium");
});

function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init, at: Date.now() });
    return respond(String(url));
  };
  return { f, calls };
}

test("GDELT articles become results, with its publication date as an ISO date and no invented snippet", async () => {
  resetGdeltPacing();
  const { f, calls } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          articles: [
            {
              url: "https://news.example/a",
              title: "Helium export curbs",
              seendate: "20261110T050000Z",
            },
            { url: "ftp://bad", title: "x" },
            { url: "https://news.example/b", title: "", seendate: "garbage" },
          ],
        }),
        { status: 200 },
      ),
  );
  const out = await gdeltProvider({ gdeltIntervalMs: 0 }, f).search("helium export", {
    limit: 5,
    lang: "en",
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results, [
    {
      title: "Helium export curbs",
      url: "https://news.example/a",
      snippet: "",
      published: "2026-11-10T05:00:00Z",
      engine: "gdelt",
    },
    {
      title: "https://news.example/b",
      url: "https://news.example/b",
      snippet: "",
      engine: "gdelt",
    },
  ]);
  const sent = new URL(calls[0].url);
  assert.equal(sent.searchParams.get("query"), "helium export sourcelang:english");
  assert.equal(sent.searchParams.get("mode"), "artlist");
  assert.equal(sent.searchParams.get("maxrecords"), "5");
  assert.match(calls[0].init.headers["User-Agent"], /ai-kit/);
});

test("GDELT's plain-text 'slow down' is rate-limited, any other message a bad response — never empty results", async () => {
  resetGdeltPacing();
  const slow = fakeFetch(
    () => new Response("Please limit requests to one every 5 seconds.", { status: 200 }),
  );
  const a = await gdeltProvider({ gdeltIntervalMs: 0 }, slow.f).search("helium", {});
  assert.equal(a.ok, false);
  assert.equal(a.failure.kind, "rate_limited");
  const odd = fakeFetch(() => new Response("Your query was too short.", { status: 200 }));
  const b = await gdeltProvider({ gdeltIntervalMs: 0 }, odd.f).search("helium", {});
  assert.equal(b.failure.kind, "bad_response");
});

test("GDELT is paced across calls, and a call that cannot wait its turn fails without being sent", async () => {
  resetGdeltPacing();
  const { f, calls } = fakeFetch(
    () => new Response(JSON.stringify({ articles: [] }), { status: 200 }),
  );
  const p = gdeltProvider({ gdeltIntervalMs: 120 }, f);
  await p.search("helium one", { timeoutMs: 5000 });
  await p.search("helium two", { timeoutMs: 5000 });
  assert.equal(calls.length, 2);
  assert.ok(
    calls[1].at - calls[0].at >= 110,
    `second call ${calls[1].at - calls[0].at} ms after the first`,
  );
  resetGdeltPacing();
  const slow = gdeltProvider({ gdeltIntervalMs: 5_000 }, f);
  await slow.search("helium three", { timeoutMs: 1000 });
  const refused = await slow.search("helium four", { timeoutMs: 1000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.failure.kind, "rate_limited");
  assert.equal(calls.length, 3, "the refused call was never sent");
  resetGdeltPacing();
});

test("a query with no word GDELT accepts is an empty answer, not a request", async () => {
  resetGdeltPacing();
  const { f, calls } = fakeFetch(() => new Response("{}"));
  const out = await gdeltProvider({ gdeltIntervalMs: 0 }, f).search("is it", {});
  assert.deepEqual(out.results, []);
  assert.equal(calls.length, 0);
});

test("Wikipedia results link to the article, strip the highlight markup, and carry no date", async () => {
  const { f, calls } = fakeFetch(() =>
    Response.json({
      query: {
        search: [
          {
            title: "Gallium nitride",
            snippet: '<span class="searchmatch">Gallium</span> nitride (GaN) &amp; more',
            timestamp: "2026-11-10T21:40:30Z",
          },
          { title: "" },
        ],
      },
    }),
  );
  const out = await wikipediaProvider({}, f).search("gallium nitride", { lang: "de-CH", limit: 3 });
  assert.deepEqual(out.results, [
    {
      title: "Gallium nitride",
      url: "https://de.wikipedia.org/wiki/Gallium_nitride",
      snippet: "Gallium nitride (GaN) & more",
      engine: "wikipedia",
    },
  ]);
  const sent = new URL(calls[0].url);
  assert.equal(sent.host, "de.wikipedia.org");
  assert.equal(sent.searchParams.get("srlimit"), "3");
  assert.match(calls[0].init.headers["User-Agent"], /ai-kit/);
});

test("Wikipedia restricted to another site has nothing there, without a request", async () => {
  const { f, calls } = fakeFetch(() => Response.json({}));
  const out = await wikipediaProvider({}, f).search("gallium", { site: "reuters.com" });
  assert.deepEqual(out.results, []);
  assert.equal(calls.length, 0);
});

test("transport failures are typed, never empty results", async () => {
  const boom = async () => {
    throw new TypeError("fetch failed");
  };
  const w = await wikipediaProvider({}, boom).search("gallium", {});
  assert.equal(w.ok, false);
  assert.equal(w.failure.kind, "unreachable");
  const status = async () => new Response("no", { status: 403 });
  const w2 = await wikipediaProvider({}, status).search("gallium", {});
  assert.equal(w2.failure.kind, "blocked");
});

test("keyless backends are partial, need no configuration, and come after the configured chain", () => {
  for (const p of keylessProviders()) {
    assert.equal(p.coverage, "partial");
    assert.equal(p.configured(), true);
  }
  assert.deepEqual(
    withKeylessFallback({ SEARXNG_URL: "http://searx.local", BRAVE_SEARCH_API_KEY: "k" }).map(
      (p) => p.name,
    ),
    ["searxng", "brave", "gdelt", "wikipedia"],
  );
  assert.deepEqual(
    withKeylessFallback({}).map((p) => p.name),
    ["gdelt", "wikipedia"],
  );
});

test("GDELT keeps OR and its parentheses, joins acronyms to a neighbour, quotes CJK, and drops stray quotes", () => {
  assert.equal(gdeltQuery("(gallium OR germanium)"), "(gallium OR germanium)");
  assert.equal(gdeltQuery("(gallium germanium)"), "gallium germanium");
  assert.equal(gdeltQuery("EU tariffs on US steel"), '"EU tariffs" "US steel"');
  assert.equal(gdeltQuery("AI chips"), '"AI chips"');
  assert.equal(gdeltQuery("芯片 出口"), '"芯片" "出口"');
  assert.equal(gdeltQuery('he said "it is'), "said");
  assert.equal(gdeltQuery("AI"), "");
});

test("a GDELT body that is not an object is a bad response, never 'unreachable'", async () => {
  resetGdeltPacing();
  const { f } = fakeFetch(() => new Response("null", { status: 200 }));
  const out = await gdeltProvider({ gdeltIntervalMs: 0 }, f).search("helium", {});
  assert.equal(out.ok, false);
  assert.equal(out.failure.kind, "bad_response");
  const rows = fakeFetch(
    () =>
      new Response(
        JSON.stringify({ articles: [null, 3, { url: "https://n.example/a", title: "A" }] }),
      ),
  );
  const ok = await gdeltProvider({ gdeltIntervalMs: 0 }, rows.f).search("helium", {});
  assert.equal(ok.results.length, 1);
});

test("a bad pacing interval cannot corrupt the shared pacing, and a near-deadline call is not sent", async () => {
  resetGdeltPacing();
  const { f, calls } = fakeFetch(() => new Response(JSON.stringify({ articles: [] })));
  const nan = gdeltProvider({ gdeltIntervalMs: Number.NaN }, f);
  const a = await nan.search("helium", { timeoutMs: 8000 });
  assert.equal(a.ok, true);
  const b = await nan.search("helium", { timeoutMs: 8000 });
  assert.equal(b.ok, true, "the default 5 s interval applied, not NaN");
  assert.ok(calls[1].at - calls[0].at >= 4900);
  resetGdeltPacing();
  const short = await gdeltProvider({ gdeltIntervalMs: 0 }, f).search("helium", { timeoutMs: 500 });
  assert.equal(short.ok, false);
  assert.equal(short.failure.kind, "rate_limited");
  assert.equal(calls.length, 2, "a call with under a second left was never sent");
  resetGdeltPacing();
});

test("Wikipedia searches the edition a site names, and an edition code that is not a plain language", async () => {
  const { f, calls } = fakeFetch(() => Response.json({ query: { search: [] } }));
  await wikipediaProvider({}, f).search("Gallium", { site: "de.wikipedia.org" });
  await wikipediaProvider({}, f).search("Gallium", { lang: "de-CH" });
  await wikipediaProvider({ wikipediaLang: "simple" }, f).search("Gallium", {});
  await wikipediaProvider({}, f).search("Gallium", { lang: "x" });
  assert.deepEqual(
    calls.map((c) => new URL(c.url).host),
    ["de.wikipedia.org", "de.wikipedia.org", "simple.wikipedia.org", "en.wikipedia.org"],
  );
});

test("a MediaWiki error in a 200 body is a failure, never an empty search", async () => {
  const { f } = fakeFetch(() => Response.json({ error: { code: "maxlag" } }));
  const out = await wikipediaProvider({}, f).search("Gallium", {});
  assert.equal(out.ok, false);
  assert.equal(out.failure.kind, "bad_response");
  assert.match(out.failure.reason, /maxlag/);
});
