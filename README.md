# ai-kit

**The AI layer of an app, in one install.** Which model to call, what to do when
the vendor deletes it, how to walk the fallback and know when none of it worked,
what to do when you're going too fast, how to share a free tier fairly between
users, and how to fill a form from plain language.

```bash
pnpm add @bitbaum/ai-kit
```

---

## Why this is one package and not four

Adding an AI feature looks like one decision and is actually four. Get any of
them wrong and the app fails **identically** from the outside: the assistant is
broken, and the error usually blames the wrong thing.

On 2026-08-26 that stopped being hypothetical. Groq retired its entire
`llama-3.x` family. Every app in this fleet that had picked a model by hand went
down at the same moment — five repos, three of them serving live traffic — and
the one app that had adopted the fallback chain was unaffected. One of the broken
ones reported *"AI assistant not configured, please set GROQ_API_KEY"* on a
deployment whose key was perfectly valid, so the first hour of the investigation
went into checking a credential that was never the problem.

That app had already adopted the form-filling half. It hand-rolled the other
half, because that was a second decision and nobody made it.

So the four decisions ship together now. Adding AI is one install.

> **Renamed from `ai-ration` in v0.3.0.** The old name described one of its five
> modules and hid the other four, and the person deciding whether to install it
> could not tell what it did. An unreadable name is a cost paid at every install
> decision — and this package had a single adopter while five repos that skipped
> it were taken down together by exactly the failure it prevents.

---

## What's in it

### Which model — a list, never a pin

```ts
import { freeChain, usableChain, chainFrom } from '@bitbaum/ai-kit';

const providers = freeChain('MYAPP');               // groq → openrouter
const links = usableChain(providers, process.env);   // drops vendors with no key
const chain = chainFrom(process.env.MYAPP_MODEL, links);
```

Falling back to a **smaller model at the same vendor buys nothing**: it draws on
the same org-wide daily budget, so when the day runs dry every link in that
"fallback" is already dead. Only a different vendor has a different meter.

**Probe before you pin.** Of nine free models probed live, **five** answered only
via a text tool protocol, not native `tool_calls`. A native-only client would
have silently lost most of the chain.

### Make the call — `complete()` owns the fetch

```ts
import { complete, freeChain, usableChain, createHealthTracker } from '@bitbaum/ai-kit';

export const llmHealth = createHealthTracker();
const chain = usableChain(freeChain('MYAPP'), process.env);

const { text, id } = await complete({
  chain,
  health: llmHealth,
  maxTokens: 500,
  messages: [{ role: 'user', content: 'Summarise this in one line.' }],
});
```

For four releases this package shipped the *decisions* and told you to keep the
fetch. The rule read well and it was wrong: measured 2026-09-05, this fleet ran
**eight** hand-rolled clients, **two** of which told the three kinds of 429
apart — while `ai-forms`, which ships a working route factory, had more than
twice this package's adoption. A package that hands you a working call gets
installed; one that hands you advice about calls does not.

`complete()` is the chain walk plus the request, and it carries the parts that
kept getting left out of the hand-rolled ones:

- a **200 with empty content is a failure**, not an answer — reasoning models
  and some vendors return exactly that, and every client that read
  `choices[0].message.content || ''` shipped the empty string to a user;
- a **daily** 429 marks the whole vendor dead for the walk, instead of trying
  its other models against the same exhausted org-wide budget;
- a **size** 429 ends the walk rather than demoting to a *smaller* ceiling,
  which is strictly worse;
- the vendor's response body survives into the error, so an exhausted day is
  distinguishable from a momentary burst in a log.

**`maxTokens` has a floor, and it is higher than you think.** The chain leads
with reasoning models, which spend the budget on hidden thinking before emitting
a visible token: `groq/openai/gpt-oss-20b` answered *empty* at 16 and correctly
at 256 for the same one-word question. A mean budget makes a healthy model look
dead.

**Every link gets its own deadline** (`timeoutMs`, default 30s). A vendor that
accepts the connection and then never answers is the most common partial outage
there is, and it is the one a fallback chain is least able to survive: without a
deadline `await fetch` never returns, link two is never reached, and the chain
that exists to survive an outage becomes the thing holding the request open.

Note it is *per link*, and that it is not the same thing as `signal`:

```ts
// ✗ WRONG — link one spends the whole budget, links two and three inherit an
//   already-aborted signal, and the "fallback" reports every vendor broken.
complete({ chain, signal: AbortSignal.timeout(10_000), messages });

// ✓ RIGHT — each link gets ten seconds; `signal` stays what it should be,
//   the caller going away.
complete({ chain, timeoutMs: 10_000, signal: request.signal, messages });
```

When the caller's `signal` aborts, the walk stops rather than touring the
remaining vendors: the request nobody is waiting for should not spend the daily
budget, nor report "every vendor failed" about vendors that were never asked.

`tryChain` stays for a caller with a genuinely unusual request to make.

### Does it work RIGHT NOW? — a probe, not a guess

```ts
// app/api/health/ai/route.ts — Next App Router, Hono, Deno and Bun all take
// this shape directly.
import { createAiHealthHandler, freeChain, usableChain } from '@bitbaum/ai-kit';
import { llmHealth } from '@/lib/llm-health';

const handler = createAiHealthHandler({
  chain: usableChain(freeChain('MYAPP'), process.env),
  health: llmHealth,
  secret: process.env.AI_PROBE_SECRET,
});

export const GET = handler;
```

```
GET /api/health/ai                          free. What happened last time.
GET /api/health/ai?probe=1  + the secret    makes a real call. 200 or 503.
```

**Why a probe and not a passive read.** Absence of failure is not evidence of
success. A tracker that has recorded nothing looks identical whether the chain
is perfect or every key is missing — and straight after a deploy that is exactly
the state it is in. Observed converting the first app: the deploy was green, the
bundle provably held the new code, both keys were present, `/api/health`
returned 200, and `llm.status` was `"unknown"`. Every available signal said
"probably fine" and none said "works". The only paths that would have answered
were an admin-authenticated form and two cron jobs that **email real users** —
verifying a deploy must never require spamming somebody.

**Why it is gated and cached.** A probe spends real tokens from a daily budget
shared with the app's actual features, so an ungated one on a health route is a
self-inflicted outage: a monitor polling every 30s would drain the allowance and
take the AI features down with it. So a probe runs only on `?probe=1` **and**
with the secret, a *success* is cached for 10 minutes (returned with `cached`
and its age, because a nine-minute-old success is a different claim from a fresh
one), and a **failure is never cached** — the whole point is the truth about
right now.

With no secret configured the route answers **501**, not an open probe: an app
that forgets to set one gets a route that cannot spend money, rather than one
that can.

### Is it up? — walk the chain, and know when none of it worked

A chain nobody walks is a list, not a fallback. This was found sitting unused
next to a single-shot caller in an app this package's `freeChain` had already
saved from a retired model — the list existed, and nothing tried link two.

```ts
import { tryChain, createHealthTracker } from '@bitbaum/ai-kit';

const llmHealth = createHealthTracker(); // one per process; see below

const { text } = await tryChain(chain, {
  health: llmHealth,
  attempt: async ({ provider, model }) => {
    // POST `${provider.baseUrl}/chat/completions` with `model` — your own
    // fetch, your own retries. Throw to demote to the next link.
    return callVendor(provider, model);
  },
});
```

`attempt` makes the real request; `tryChain` only
decides which link goes next and throws `ChainExhaustedError` (naming every
link's failure, not just the last) when none of them work.

`createHealthTracker()` is a factory, not a global: a single-process app gets
the old "shared state everywhere" behaviour for free by making exactly one and
exporting it —

```ts
// lib/llm-health.ts
export const llmHealth = createHealthTracker();
```

— and a health route reports `llmHealth.getHealth()` instead of only ever
checking the database. That gap is not hypothetical: an app's `/health` reported
"healthy" while its only configured key was returning 401 and every chat route
was answering a friendly, silent, hardcoded apology. HTTP 200 is not evidence.

### Still there? — catch a retirement before a user does

```ts
import { freeChain, checkCatalog, hasRot, catalogReport } from '@bitbaum/ai-kit';

const verdicts = await checkCatalog(freeChain('MYAPP'));
if (hasRot(verdicts)) console.warn(catalogReport(verdicts));
```

One `GET /models` per vendor. **Zero tokens**, which is what makes it
schedulable — and "somebody is supposed to remember" is precisely what failed.

Three states, not two: a catalogue that could not be read reports **unchecked**,
never *gone*. Treating "I could not look" as "nothing is there" marks every model
retired and invents an outage someone then acts on.

> This fleet runs it daily across every repo from
> [`fleet/scripts/ci/model-pin-audit.mjs`](https://github.com/bitbaum/fleet).

### Too fast? — the three kinds of 429

```ts
import { classifyRateLimit, rateLimitMessage } from '@bitbaum/ai-kit';

classifyRateLimit(body); // 'capacity' | 'size' | 'daily'
```

They share a status code, a `type` and a `code`. Only the body tells them apart,
and they need **opposite** responses: retry shortly, shrink the request, or give
up on this vendor until tomorrow.

`retryAfterSeconds` is present only for the refusal a wait actually fixes.
Telling someone whose daily quota is gone to try again in 20 minutes is a lie.

### Who gets it — fair shares of a free tier

```ts
import { fairShare, utcDayElapsed } from '@bitbaum/ai-kit';
```

A free tier grants roughly 100k tokens **per day for an entire org**, and one
measured tool-calling turn cost ~16k — about six turns a day. Divided badly, the
first enthusiastic user spends it before lunch and everyone after them meets a
wall, including the person trying the product for the first time, who concludes
it is broken and never comes back.

Shares are `capacity / active users`, recomputed per request, where *active*
means users who actually drew today — one user on a quiet day correctly gets
everything. The allowance unlocks gradually through the day, with a **one-turn
floor** so nobody's first question of the morning is refused.

Whatever you pass as `costTokens` must err **high**: under-estimating admits
turns the pool cannot cover, draining the day while the gate still believes there
is room.

### Filling forms — from prose, then by talking to it

```ts
import { runFormAssist } from '@bitbaum/ai-kit/forms';
import { useAiForm } from '@bitbaum/ai-kit/react';
import { createFormAssistHandler } from '@bitbaum/ai-kit/server';
```

Re-exported from [`ai-forms`](https://github.com/bitbaum/ai-forms), which
stays its own package — it works, four apps run it, and it is useful well outside
this fleet. Swallowing it would have broken those four for the sake of a filing
system.

**Note the subpath.** Form filling is at `@bitbaum/ai-kit/forms`, not at the root. For one
release it was both, and the first app to adopt the merged package paid for it:
`ai-forms` is ESM-only, so importing the *chain* from the root dragged the forms
package in behind it and the app's Jest run — which executes CJS — died inside a
module it never asked for. One install is still the whole promise; the exports
map is what keeps it, while letting a server that only wants a provider chain
stop paying for a form library.

React lives on its own subpath and is an **optional** peer, so importing
`@bitbaum/ai-kit` on a server never pulls in a UI library.

### Seeing the web — search and read, as citable facts

```ts
import { webSearch, readPage, resultsToFacts, describeEmptySearch } from "@bitbaum/ai-kit/web";
import { assignFactIds, renderFacts } from "@bitbaum/ai-kit/grounding";

const found = await webSearch("lightning address spec", { limit: 5 });
if (found.status !== "found") {
  return describeEmptySearch(found); // the model is told WHICH of the two this is
}
const facts = assignFactIds(resultsToFacts(found.results, found.provider));
```

Backends are a chain, in the same shape and for the same reason as the model
chain: `searxng` (self-hosted, no key, no third party told what your users are
looking for) → `brave` (an independent index, so the fallback is not the same
index asked twice) → `tavily`. Each is included only if its env is set, so the
common case is one call rather than a policy re-decided in every app.

**The answer is three-valued, and that is the whole point.** `found`; `nothing`
(a backend answered and had nothing — a real negative the model may state); and
`could_not_look` (nobody answered — an outage, which the model must **not**
report as a fact about the world). Collapsing the last two into `[]` is how an
expired API key becomes a confident sentence about what does not exist on the
internet. A backend that answers `200` with zero results is walked past rather
than believed, because that is exactly what a self-hosted metasearch instance
does when its upstream engines refuse it.

`readPage()` is the other half — search returns titles and one sentence, and
almost every real question needs the page. It fetches with `redirect: "manual"`
and re-runs the **full SSRF check on every hop**, because an agent picks its own
URLs: any page it reads can hand it a link to the cloud metadata service, and
validating the first URL and then letting `fetch` follow the 302 is not a check
at all. Truncation is stated in the result rather than implied, so a summary can
say "the first part of the page" instead of implying it read all of it.

Both produce `Fact`s from `/grounding` rather than a bespoke shape, so retrieved
web content and retrieved database rows flow through **one** verifier and "cite
your sources" becomes a string check instead of a line in a prompt. Search
without citation binding makes hallucination worse, not better: the invented
sentence is now surrounded by real ones.

It does not summarise, re-rank with an LLM, crawl, render JavaScript, or cache.
The first two are the model's job and belong upstream where the app's prompt
lives; the last three are a different product with a different cost profile.

---

## What it deliberately does not ship

**~~An HTTP client.~~** It ships one now — see [`complete()`](#make-the-call--complete-owns-the-fetch).
The old rule ("every app has its own calling conventions, and replacing those is
a rewrite rather than an adoption") described this fleet's duplication
accurately and then protected it: the conventions differed because nothing had
ever offered to own them.

**Model values.** Which ids are free, which are billed, and which your account
may use are properties of *your* deployment. Centralise the rule, assert it
locally.

---

## Related

| Package | For |
|---|---|
| [`ai-forms`](https://github.com/bitbaum/ai-forms) | Form filling on its own, without the model layer |
| [`threadkit`](https://github.com/bitbaum/threadkit) | Messages between people, and who may see them |
| [`limitkit`](https://github.com/bitbaum/limitkit) | Stopping someone doing something too often |

`threadkit` and `limitkit` are **not** merged in here, on purpose: neither has
anything to do with AI. An app that throttles its login form should not install a
model catalogue to do it.

## Knowing what is left

```ts
const result = await complete({
  messages,
  onQuota: (readings) => void recordQuota(readings), // your table, your call
});
```

Every vendor answer carries what it was willing to disclose about your remaining
allowance, and this hands it to you on success **and on refusal**. No extra
request: the number arrives on the exchange you were making anyway.

**Do not poll a vendor's usage endpoint instead.** Measured on one live key,
within the same second:

```
GET  /api/v1/key         →  limit_remaining: null,  usage_daily: 0
POST /chat/completions   →  429, x-ratelimit-remaining: 0 of 50,
                            "Rate limit exceeded: free-models-per-day"
```

Both are OpenRouter, about the same account, and the account was locked out. The
usage endpoint tracks money; free models cost nothing; the limit that actually
binds is a request count it never reports. A dashboard built on the first line
shows a full tank during a total outage.

Three things this will not do, each deliberate:

- **It never invents a reading.** A vendor that sends no headers produces none.
  Absent is a third state next to known and empty — render it as *unknown*,
  because drawing it full repeats the bug above and drawing it empty invents an
  outage.
- **It never guesses a window.** `x-ratelimit-remaining-requests` counts a day at
  Groq and a minute elsewhere, so the window comes from a verified per-provider
  profile or from the header's own name, and is otherwise reported as unknown.
- **It never stores anything.** Persisting is the app's job, which is why this is
  a callback. The package has no database and should not grow one.

`answersRemaining(reading, tokensPerTurn)` converts a token count into the unit a
person actually thinks in. Nobody has an intuition for a token; "about 40 more
answers" is actionable, and "7,927 tokens" is a sum the reader has to do and will
get wrong.

## Versioning

**This package is 1.x, and that is a functional decision rather than a
milestone.**

While it was `0.x`, every consumer was frozen at whatever minor it first
installed, and nobody chose that. A caret range on a pre-1.0 version does not
cross a minor — `^0.13.0` resolves to *at least 0.13.0 and below 0.14.0* —
because semver treats a `0.x` minor as a breaking change. So eleven repos sat on
five different versions of this package, spanning `0.6.2` to `0.15.0`, while the
registry served `0.16.0` to none of them.

The automation was not broken and nobody was neglecting it. Dependabot ran weekly
in every one of those repos, correctly classified each `0.x` minor as a breaking
change, and correctly routed it to its own pull request for a human to review —
which is the right policy for a breaking change and the wrong outcome for a
package whose minors were additive in practice. The version numbering defeated
the process.

From here:

- **Minor releases are additive.** New exports, new providers, new options with
  defaults. Safe to take automatically, and your caret range will.
- **Major releases remove or change something.** They get a migration note and
  they are meant to be read before merging.
- **Patch releases fix behaviour** without changing the surface.

The upgrade *to* 1.0.0 is the one exception, and it is a real one: a repo coming
from `0.6.x` crosses ten minors of a package that was permitted to break at each
of them. Run your own suite. Afterwards, the point is that you will not have to
again.

### Keep the volatile things out of the version

Model ids rot on a timescale of weeks — vendors retire them with little notice,
and a free catalogue rotates faster than that. Anything on that clock does not
belong in a release, because shipping it means a version bump per rot and one
upgrade per consumer to deliver a fact that was true yesterday.

So this package ships the *logic* — how to discover a catalogue, how to walk a
chain, how to read a refusal — and keeps the perishable data in the environment
and in live catalogue fetches. That is what makes being a version behind
uninteresting, which is a better property than being always current.

## Development

```bash
pnpm run verify  # lint + typecheck + build + test
```

MIT.
