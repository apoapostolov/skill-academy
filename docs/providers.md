# Providers

Ported from String Theory (`C:\git-public\string-theory`, read 2026-11-02): `server/providers.mjs`, `server/models-cache.mjs`, `server/oauth.mjs`, `server/pricing.mjs`. The port keeps the provider set, the wire formats, the auth rules, the catalogue cache and the error classification. It adds nothing that the source does not already do.

## Registry

Eleven entries. `kind` selects the wire format, not the vendor.

| id | Label | kind | Endpoint | Key |
|---|---|---|---|---|
| `openai` | OpenAI | openai | `https://api.openai.com/v1` | yes |
| `anthropic` | Anthropic | anthropic | `https://api.anthropic.com/v1` | yes |
| `gemini` | Google Gemini | gemini | `https://generativelanguage.googleapis.com/v1beta` | yes |
| `deepseek` | DeepSeek | openai | `https://api.deepseek.com/v1` | yes |
| `openrouter` | OpenRouter | openai | `https://openrouter.ai/api/v1` | yes |
| `mistral` | Mistral AI | openai | `https://api.mistral.ai/v1` | yes |
| `qwen` | Qwen (DashScope) | openai | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` | yes |
| `zai` | Z.ai | openai | `https://api.z.ai/api/paas/v4` | yes |
| `opencode-go` | OpenCode Go | openai | `https://opencode.ai/zen/go/v1` | yes |
| `xai` | xAI | openai | `https://api.x.ai/v1` | yes/key or sign-in |
| `local` | Local (Ollama / LM Studio) | openai | `http://127.0.0.1:11434/v1` | no |

Seeded model lists are copied from the source and are only a first paint. The real catalogue is fetched (below) so a new model appears without a release.

## Wire formats

Three shapes, one interface: `chat(binding, {system, user, temperature, maxTokens}) -> {text, inputTokens, outputTokens, model, ms}`.

**OpenAI-compatible.** `POST {base}/chat/completions`, bearer key, `messages[]`. Every `kind: openai` provider uses this, including DeepSeek, Z.ai, Qwen, OpenCode Go, xAI and local servers.

**Anthropic.** `POST {base}/messages` with `x-api-key` and `anthropic-version: 2023-06-01`. With a subscription session the auth changes: `Authorization: Bearer` plus `anthropic-beta: oauth-2025-04-20`, and no `x-api-key`. Text is joined from `content[]` where `type === 'text'`.

**Gemini.** `POST {base}/models/{model}:generateContent?key=…` with `systemInstruction`, `contents[]`, `generationConfig`. Text is joined from `candidates[0].content.parts[]`. Usage comes from `usageMetadata`.

**OpenAI with a ChatGPT session (Codex).** A session token is not a platform key. It is only accepted by `https://chatgpt.com/backend-api/codex` (overridable with `ST_CODEX_BASE`), needs `originator: codex_cli_rs` and `OpenAI-Beta: responses=experimental`, `POST /responses` with `instructions` and `input[]`, `store: false`, `stream: true`, and an SSE body that must be parsed rather than read as JSON. `chatgpt-account-id` is sent when the session carries an account id. Getting any of this wrong produces a 404 from the platform API that looks like a bad model name. Port it as written.

## Auth

Two credential kinds, never mixed:

- **API key.** Stored per provider. Sent as `x-api-key` (Anthropic) or `Authorization: Bearer` (the rest).
- **OAuth session.** Device code or code-callback, with a refresh token. Session tokens are bearer tokens; an API key is not. The two paths never share headers.

Ported flows:

| Provider | Flow | Notes |
|---|---|---|
| xAI | RFC 8628 device code | `auth.x.ai/oauth2/device/code` → poll `token`; verification fallback `accounts.x.ai/oauth2/device` |
| Anthropic | Code callback | Authorize at `claude.ai/oauth/authorize`, user pastes the code; token at `console.anthropic.com/v1/oauth/token`; no local listener |
| OpenAI (Codex) | Device auth | `auth.openai.com/api/accounts/deviceauth/usercode` → poll `token`; callback `deviceauth/callback` |

Rules from the source worth repeating because they are easy to lose in a port:

- In-flight device codes live in memory; a service restart cancels them and the UI says so.
- Token resolution order for a command: explicit argument, environment variable, saved credential for that registry/provider.
- An invalid saved token does not silently fall back to a fresh device flow; it reports `rejected` so the user can see the dead credential.
- Refresh is attempted once before a call fails with 401.

## Catalogue

`GET /models` per provider is both the model list and the health check: a 200 proves the credential works. Ported behaviour:

- Cached on disk with a 24-hour TTL, re-fetched when stale or when credentials change.
- One fetch per provider at a time; a key save and a page load collide otherwise.
- A rejected credential backs off for 5 minutes so Settings does not hammer the provider on every keystroke.
- Failures are classified, not flattened: `rejected` (401), `limited` (403/404/405, or a key that can polish but cannot read the catalogue), `unreachable`. The UI wording differs per class because the fix differs.
- A failed fetch never overwrites a good cache.

Skill Academy additions, both mechanical: the cached catalogue is stored per provider in SQLite so the model picker paints instantly, and each cached entry records when it was fetched for display (`models updated 4h ago`).

## Pricing and budgets

`pricing.mjs` becomes a small table of input/output dollars per million tokens keyed by provider and model, with an `unknown` fallback that shows token counts and a dash for cost rather than inventing a price.

Every model call writes an `llm_runs` row: provider, model, tokens in and out, computed cost, duration, status. Three budgets:

- Per run: curation runs take a `budget_usd` and stop cleanly at 90%, writing a partial report.
- Per day: a soft cap that turns further automatic work into a notification instead of a call.
- Per provider: an optional monthly cap for metered providers.

The UI shows the estimate before a run (`about $0.42 at current prices`) and the actual after.

## Key storage

- OS keychain through `@napi-rs/keyring`, service name `skill-academy`, account `provider:<id>`.
- Fallback when the keychain is unavailable: DPAPI-encrypted file under the data directory, with a warning in Settings › Providers.
- Never in SQLite, never in `config.json`, never in an SSE payload, never in a log line. Log redaction strips `Authorization`, `x-api-key`, `key=`, and anything matching `sk-[A-Za-z0-9_-]{16,}`.
- The renderer sees only `{id, label, kind, endpoint, needsKey, hint, authMode, hasKey, lastCheck}`.

## Test call

`POST /api/providers/:id/test` does two things and reports both separately: fetch the catalogue, then send one 8-token completion. A key that can list models but not complete is a real state (scope-limited keys) and must not read as "connected".

The response is the ported classification plus a readable sentence: `Connected. 41 models.` / `Anthropic returned 401: invalid x-api-key` / `Key works for listing but is not allowed to complete (403 on messages).`

## Where the port ends

Everything above is String Theory behaviour. The only new surface is the binding layer: a task (`curate.cluster`, `curate.write`, `curate.report`) resolves to a provider, a model and a budget. That is Skill Academy's code, and it is deliberately thin: it selects a binding, calls `chat`, and records usage.

Adding a provider later means one registry entry and, only if the wire format is new, one branch in `chat`. The Gemini and Anthropic branches are the template for that.

## Verification

- A recorded fixture per wire format asserts the exact request shape: headers, body keys, auth mode.
- A live smoke test runs the eleven providers with whatever credentials exist on the machine and reports per provider; it is manual, never in CI.
- The Codex branch has a fixture with an SSE body, because that is the branch most likely to be "fixed" into breakage by a later refactor.
