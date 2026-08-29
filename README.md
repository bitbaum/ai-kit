# ai-kit

**The AI layer of an app, in one install.** Which model to call, what to do when
the vendor deletes it, how to walk the fallback and know when none of it worked,
what to do when you're going too fast, how to share a free tier fairly between
users, and how to fill a form from plain language.

```bash
npm install ai-kit
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
import { freeChain, usableChain, chainFrom } from 'ai-kit';

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

### Is it up? — walk the chain, and know when none of it worked

A chain nobody walks is a list, not a fallback. This was found sitting unused
next to a single-shot caller in an app this package's `freeChain` had already
saved from a retired model — the list existed, and nothing tried link two.

```ts
import { tryChain, createHealthTracker } from 'ai-kit';

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

No HTTP client here either — `attempt` makes the real request; `tryChain` only
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
import { freeChain, checkCatalog, hasRot, catalogReport } from 'ai-kit';

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
import { classifyRateLimit, rateLimitMessage } from 'ai-kit';

classifyRateLimit(body); // 'capacity' | 'size' | 'daily'
```

They share a status code, a `type` and a `code`. Only the body tells them apart,
and they need **opposite** responses: retry shortly, shrink the request, or give
up on this vendor until tomorrow.

`retryAfterSeconds` is present only for the refusal a wait actually fixes.
Telling someone whose daily quota is gone to try again in 20 minutes is a lie.

### Who gets it — fair shares of a free tier

```ts
import { fairShare, utcDayElapsed } from 'ai-kit';
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
import { runFormAssist } from 'ai-kit/forms';
import { useAiForm } from 'ai-kit/react';
import { createFormAssistHandler } from 'ai-kit/server';
```

Re-exported from [`ai-forms`](https://github.com/bitbaum/ai-forms), which
stays its own package — it works, four apps run it, and it is useful well outside
this fleet. Swallowing it would have broken those four for the sake of a filing
system.

**Note the subpath.** Form filling is at `ai-kit/forms`, not at the root. For one
release it was both, and the first app to adopt the merged package paid for it:
`ai-forms` is ESM-only, so importing the *chain* from the root dragged the forms
package in behind it and the app's Jest run — which executes CJS — died inside a
module it never asked for. One install is still the whole promise; the exports
map is what keeps it, while letting a server that only wants a provider chain
stop paying for a form library.

React lives on its own subpath and is an **optional** peer, so importing `ai-kit`
on a server never pulls in a UI library.

---

## What it deliberately does not ship

**An HTTP client.** Every app has its own calling conventions, retries and
logging, and replacing those is a rewrite rather than an adoption. This supplies
the decisions; you keep the fetch.

That rule is under review, and honestly. `ai-forms` is the most-adopted package
in this fleet and it is the one that broke the rule, by shipping a route factory
and a React hook. A package that hands you a working route gets installed; one
that hands you advice about routes does not.

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

## Development

```bash
npm run verify   # lint + typecheck + build + test
```

MIT.
