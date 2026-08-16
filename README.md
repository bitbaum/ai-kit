# ai-ration

Keep an LLM app on free tiers, and share what is free fairly.

Three small, pure modules. No HTTP client, no SDK, no framework — every app
already has its own calling conventions, and replacing those is a rewrite rather
than an adoption. **This package supplies the decisions; you keep the fetch.**

```bash
npm install github:maonakamoto/ai-ration#v0.1.0
```

## Why

Free LLM tiers fail in three specific ways, and each one has been mistaken for an
application bug at least once:

| Failure | What it looks like | What actually fixes it |
|---|---|---|
| A pinned free model is retired | "the assistant is broken" | a chain, not a pin |
| The vendor's daily budget is gone | a 429 that retrying never clears | a **different vendor** |
| One eager user spends the day's tokens by 10am | everyone else meets a wall | rationing |

The third is the one that costs you users, because the person who hits the wall
is usually the one trying the product for the first time.

## `chain` — a fallback list across vendors

```ts
import { freeChain, usableChain, chainFrom } from 'ai-ration';

const providers = freeChain('MYAPP');            // groq → openrouter, free models
const links = usableChain(providers, process.env); // drops vendors with no key
for (const { provider, model } of chainFrom(process.env.MYAPP_MODEL, links)) {
  // POST `${provider.baseUrl}/chat/completions` with `model`
  // on failure, continue — that is the whole point
}
```

Both properties are load-bearing. Falling back to a **smaller model at the same
vendor** buys nothing: it draws on the same org-wide daily budget, so when the
day runs dry every link in that "fallback" is already dead. Only a different
vendor has a different meter.

**Probe before you pin.** Of nine free models probed live for the default chain,
**five** answered only via a text tool protocol, not native `tool_calls`. A
native-only client would have silently lost most of the chain. The shipped list
is evidence from one day, not a constant — free catalogues rot, so re-probe.

## `limits` — the three kinds of 429

They share a status code, a `type`, and a `code`. Only the body tells them apart,
and they need **opposite** responses:

```ts
import { classifyRateLimit, rateLimitMessage } from 'ai-ration';

classifyRateLimit(body); // 'capacity' | 'size' | 'daily'
```

- **capacity** — the per-minute window is spent. Wait, or step down.
- **size** — one request exceeds the whole window. Waiting *never* helps, and
  stepping down makes it strictly worse (the cheaper model has a smaller
  ceiling). Only a smaller prompt helps.
- **daily** — the day's budget is gone, org-wide. Every response that works for
  capacity is actively harmful: a step-down draws on the same exhausted budget,
  and a 25-second wait is nothing against a reset measured in tens of minutes.

`rateLimitMessage(body)` returns a clause you embed in your own framing. It says
whether waiting can help and when, because "try again shortly" on an exhausted
day invites exactly the retry that is guaranteed to fail for the next hour.

An unrecognised body degrades to `capacity` — the safe guess, since its response
is harmless when wrong.

## `fair-share` — divide a fixed daily pool

Pure policy: no database, no clock, no provider. You own *"what has this user
spent today"*; it owns *"may they spend more"*.

```ts
import { fairShare, utcDayElapsed } from 'ai-ration';

const decision = fairShare({
  dayCapacityTokens: dayCapacityTokens(providers, process.env),
  activeUsers,        // distinct users who drew TODAY, including this one
  userSpentTokens,
  costTokens: ESTIMATED_TURN,
  dayElapsed: utcDayElapsed(new Date()),
});
// decision.reason: 'ok' | 'paced' | 'share-spent' | 'no-capacity'
```

Two ideas, both needed:

1. **Share** = capacity ÷ users *active today*. Recomputed per request, so a new
   user is counted the moment they arrive. Counting dormant accounts would ration
   a quiet day down to nothing.
2. **Pacing** — a share is a whole-day allowance, and the day is consumed in
   order. Without pacing, three users legitimately spend their full shares by
   09:00 and the fourth finds nothing left. So the allowance unlocks gradually.

Plus a **one-turn floor**: the allowance never sits below the cost of a single
turn, so nobody's first question of the morning is refused. Without it, pure
pacing tells a first-time user to come back in three hours — indistinguishable
from broken.

`retryAfterSeconds` is present **only** for `paced`, the one refusal a wait
actually fixes. Telling someone whose share is spent to try again in 20 minutes
is the same lie as "try again shortly" on an exhausted daily quota.

No clawback: a user who spent under a larger share when they were alone is not
punished when a second user appears — their allowance simply stops growing.

## Estimating a turn

Whatever you pass as `costTokens` must err **high**. Under-estimating admits
turns the pool cannot cover, draining the day while the gate still believes there
is room. One measured turn on a free model — a single tool call — cost **~16k
tokens**; an estimate of 10k had been documented as "deliberately on the high
side" and was 37% below it. Measure, then replace the estimate with the mean.

## Development

```bash
npm run verify   # build + test
```

MIT.
