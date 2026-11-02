# Changelog

This retrospective record was added on 2026-10-27 from the immutable sources
linked below. Git commit dates are source dates, not inferred npm publication
dates. A GitHub release does not itself establish npm publication.
Application adoption and deployment evidence are tracked separately.

## Unreleased

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
