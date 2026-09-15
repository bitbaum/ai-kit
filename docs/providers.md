# Inference providers — what we know, and how we know it

A register rather than a shortlist. The point is that a provider ruled out today
because it costs money is a provider worth revisiting the moment there is a
budget — and that the reason for each verdict survives long enough to be
re-checked rather than re-guessed.

Every claim below carries the date it was verified and the evidence. Anything
without evidence is marked UNVERIFIED and must not be wired.

---

## The rule this register exists to enforce

**A vendor is only "free" once a real key has served a real completion.**

Two cheap probes look like verification and are not:

- **An unkeyed 401/403 proves the HOST EXISTS**, nothing more. Cerebras cleared
  that bar and then refused every completion with `402 payment_required`. It was
  carried as a free vendor for two days on the strength of it.
- **An unkeyed 404 does NOT mean absent.** Google's OpenAI-compatible
  `/v1beta/openai/models` answers 404 without a key and **200 with one**. It sat
  in a rejected list on the reasoning that the endpoint had no catalogue.

So an unkeyed probe cannot separate "absent" from "hidden behind auth" **in
either direction**. Get a key, call `/models`, send one completion with tools,
and check the answer is non-empty. Then wire it.

---

## Wired in `freeChain()`

| Vendor | Free? | Quota shape | Verified |
| --- | --- | --- | --- |
| **Groq** | Yes | Per MODEL: requests/day and TPM each. Tokens/day is org-wide and appears in NO header — only in the 429 body (see `readingFromRefusalBody`). | 2026-09-13 |
| **Google (Gemini)** | Yes | Per PROJECT — the only pool an app need not share. Free tier qualification is "active project or free trial", **no billing account**. | 2026-09-15 |
| **OpenRouter** | Yes | **50 requests/day for the whole ACCOUNT** unpaid. A one-time $10 credit raises it to 1000/day, and `:free` models never consume that credit. | 2026-09-13 |

Chain order is **capacity, not preference**: the scarcest pool goes last, which
is why OpenRouter is the final link despite having the widest catalogue.

**The Google trade, stated because it is a real one:** its free tier says
content is used to improve Google's products; the paid tier says the opposite.
It is the second-to-last link, so the exposure is the tail of traffic.

---

## Not free — revisit when there is a budget

Kept with prices so the decision can be made on numbers rather than re-litigated
from scratch.

| Vendor | Terms | Price (per 1M tokens) | Verified |
| --- | --- | --- | --- |
| **Cerebras** | **No permanently free tier.** $5 trial credits that **expire 30 days** after being granted, consumed by usage. Their FAQ: *"Is there a permanently free tier? No."* A fresh key answers `402 payment_required` on every completion while `/models` returns 200. | gpt-oss-120b $0.35 in / $0.75 out · qwen-3.8-27b $0.99 / $1.49 | 2026-09-15 |
| **SambaNova** | Public catalogue (7 models), all priced above zero. | — (catalogue publishes pricing) | 2026-09-15 |
| **Chutes** | Public catalogue (14 models), all priced above zero. | — | 2026-09-15 |
| **DeepInfra** | Public catalogue, OpenAI-compatible. | — | 2026-09-15 |

**Worth knowing for later:** Cerebras is the fastest inference available
(~3000 tok/s on gpt-oss-120b). When there is budget for recurring spend rather
than one-time fees, it is the strongest latency story on this list.

---

## Candidates — endpoint confirmed, terms UNVERIFIED

These answered a probe, so the host and path exist. **None has been verified
with a key**, so none is wired. Each needs one key and ten minutes.

| Vendor | Endpoint | Unkeyed | Note |
| --- | --- | --- | --- |
| **Novita** | `api.novita.ai/v3/openai` | 200, 117 models | **8 models priced at zero**, all `type=chat` with `function-calling` — `inclusionai/ling-3.0-flash-{fin,sante,vl}`, `dev/glm46`, `bunny`. Best free candidate on this list. **Avoid `qwen3.5-plus` / `qwen3.6-plus`: priced 0 but `is_tiered_billing=true`**, which is the shape that starts billing at volume. |
| **NVIDIA NIM** | `integrate.api.nvidia.com/v1` | 200, 81 models | Catalogue publishes no pricing, so free-ness cannot be read from it. Known for free signup credits. |
| **Hugging Face** | `router.huggingface.co/v1` | 200, 142 models | Routes to many upstream providers; catalogue carries a `providers` field but no pricing. |
| **Mistral** | `api.mistral.ai/v1` | 401 | Has a free "Experiment" tier historically. |
| **Scaleway** | `api.scaleway.ai/v1` | 401 | EU-hosted, which may matter for data residency. |
| **Cloudflare Workers AI** | `api.cloudflare.com/client/v4/accounts/<id>/ai/v1` | 405 on GET | Needs an account id in the path. Has a genuinely free daily allowance and **no card required** — the strongest untested candidate after Novita. |

---

## Retired — do not re-add

| Vendor | Why | Verified |
| --- | --- | --- |
| **GitHub Models** | `models.github.ai` answers **410** on every path with `github_models_retirement_brownout`. The older `models.inference.ai.azure.com` host no longer resolves. It was the tempting one — a token from an account we already have, no signup — and it is gone. | 2026-09-12 |

---

## Adding a provider

1. Get a key. Nothing below this line is meaningful without one.
2. `GET {baseUrl}/models` — 200 and a non-empty list.
3. `POST {baseUrl}/chat/completions` with a real tool definition — expect a
   native `tool_calls` response. A model that cannot emit one cannot drive a
   tool loop no matter how cheap it is. `groq/compound-mini` advertises 70000
   TPM and answers `tool calling is not supported with this model`.
4. A plain completion must return **non-empty** content. An empty 200 is the
   majority shape of a free model failing, and the only one a naive client
   scores as success.
5. Check the id format the CATALOGUE uses. Google lists every id with a
   `models/` prefix while `/chat/completions` accepts both — configure the
   prefixed form, or the rot check reports a working model as missing on every
   single run.
6. Add one row to `freeChain()`. Consumers get it from a version bump.
