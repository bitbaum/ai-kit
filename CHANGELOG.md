# Changelog

This retrospective record was added on 2026-10-27 from the immutable sources
linked below. Git commit dates are source dates, not inferred npm publication
dates. A GitHub release does not itself establish npm publication.
Application adoption and deployment evidence are tracked separately.

## Unreleased

## 1.28.0

- **The usage log needs no per-app setup on a box.** 1.27.0 wrote only where `AI_USAGE_DIR` was exported, and apps whose launch script predates that variable wrote nothing: on 2026-11-13 the fleet picture listed two apps. `usageDir(env)` is `AI_USAGE_DIR` when set, otherwise `BOX_USAGE_DIR` (`/opt/fleet/ai-usage`) when that directory exists, otherwise none; `AI_USAGE_DIR=off` writes nowhere. `emitUsage` uses it. Both are exported.

## 1.27.0

- **One line per model call, for every app on a box** (`usage-log`). The chain walk reports each link it touches: the app, the vendor, the model, and whether it was served, failed at the vendor (status and kind) or refused by the spend rules (which rule), with tokens and time when known. Never a prompt, an answer or a key. With `AI_USAGE_DIR` set, each event is appended to `<dir>/<UTC day>.jsonl`; a box sets it once and every app writes there with no app code. `setUsageSink()` sends events elsewhere.
- `readUsageDay(dir, day)` and `summariseUsage(events)`: per vendor (its models, the apps that used it, the last failure) and per app (the vendors it used). "Could not look" is `null`, never an empty day.

## 1.26.0

- **Google is out of the free chain; it bills.** `freeChain()` put Google's Gemini API second on a fleet-wide `GEMINI_API_KEY`, described as a free per-project tier; the project had billing and the fleet spent about $567 on 10-11 Nov 2026 falling through to it. The default chain is Groq, then OpenRouter `:free`. `visionProviders()` loses the Google seat; the free vision left is OpenRouter's `:free` Gemma id, otherwise vision is unavailable.
- **Paid AI is off unless a feature opts in** (`spend`): `AI_PAID_DISABLED` is on when unset; `AI_PAID_OK` / `{PREFIX}_AI_PAID_OK` opts an app in. `usableChain()` drops paid providers (Google, xAI, Anthropic, OpenAI by host or key name, or `paid: true`) unless allowed; a reader's own key is unaffected.
- **Daily paid caps**, fleet (90 calls / 120,000 in / 60,000 out) and per app (`APP_DAILY_PAID`, aliases, unknown 1 / 800 / 400, no-AI apps 0), xAI 0 until opted in then 2 / 2,000 / 1,000, and a 5,000-call free loop guard. A reached cap throws `SpendLimitError` and never walks to another paid vendor.
- `@bitbaum/ai-kit/images`: every paid transport (including `"gemini"`) is gated the same way; `ownKey: true` for a person's own key.

- `@bitbaum/ai-kit/web` (1.25.0): keyless fallback backends for when every configured one is down. `gdeltProvider` (GDELT DOC 2.0 news search, paced to one request every five seconds per process) and `wikipediaProvider` (one Wikipedia edition), `keylessProviders()` and `withKeylessFallback(env)`. A provider may declare `coverage: "partial"`; a partial index answering empty never makes a search `nothing`. `defaultProviders` is unchanged.
- `@bitbaum/ai-kit/images`: one image-generation transport — OpenAI-style `/images/generations`, OpenRouter chat with image output, Gemini `generateContent`. Caller passes key and model; never throws. Replaces OrangeCat's app-local client (migration pending) and serves BiasLens.

## 1.22.0

- `@bitbaum/ai-kit/mcp`: an MCP client, the way a product's bots reach a connector. Streamable HTTP, a bearer token the caller holds, `initialize` once with the session id carried, `tools/list` and `tools/call`, and both response shapes the transport allows (a JSON body or an SSE stream) read the same way. `toolDefinitionsFrom` hands the server's tools back in the shape `complete()` takes. No OAuth flow (that is the product's, with its consent screen), no stdio, no resources or prompts until a caller needs them. First callers: OrangeCat's bots reaching Loki's `/api/mcp` as the person.

## 1.21.4

- [Tagged source `v1.21.4`](https://github.com/bitbaum/ai-kit/tree/f80949a7cce18f196d6a7740503c8d585bbb6b44)
- [Source commit](https://github.com/bitbaum/ai-kit/commit/f80949a7cce18f196d6a7740503c8d585bbb6b44), dated 2026-10-25.
- [GitHub release](https://github.com/bitbaum/ai-kit/releases/tag/v1.21.4), published 2026-10-25.

### Recorded release notes

#### What's Changed
* chore(deps): bump the minor-and-patch group across 1 directory with 5 updates by @dependabot[bot] in https://github.com/bitbaum/ai-kit/pull/83
* chore(deps-dev): bump the minor-and-patch group with 4 updates by @dependabot[bot] in https://github.com/bitbaum/ai-kit/pull/84
* feat(usage): what the budget numbers mean, defined once (1.21.0) by @catomean in https://github.com/bitbaum/ai-kit/pull/85
* ci(publish): a merged version bump publishes itself by @catomean in https://github.com/bitbaum/ai-kit/pull/86
* chore(deps-dev): bump the minor-and-patch group with 3 updates by @dependabot[bot] in https://github.com/bitbaum/ai-kit/pull/87
* ci: cut scheduled CI minutes (CI audit) by @catomean in https://github.com/bitbaum/ai-kit/pull/88
* Fix false private-network rejection of public article hosts by @catomean in https://github.com/bitbaum/ai-kit/pull/89
* Preserve citation destinations when reading articles by @catomean in https://github.com/bitbaum/ai-kit/pull/90
* Keep page navigation out of article analysis context by @catomean in https://github.com/bitbaum/ai-kit/pull/91
* chore(deps-dev): bump the minor-and-patch group with 2 updates by @dependabot[bot] in https://github.com/bitbaum/ai-kit/pull/92
* Fix fragmented and multiline SSE parsing by @catomean in https://github.com/bitbaum/ai-kit/pull/93
* chore: add the fleet package template files this repo is missing (git-release.yml, release.yml) by @catomean in https://github.com/bitbaum/ai-kit/pull/94


**Full Changelog**: https://github.com/bitbaum/ai-kit/compare/v1.20.1...v1.21.4
