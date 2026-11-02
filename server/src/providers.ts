import { randomUUID } from 'node:crypto'
import { getOverride, setOverride } from './providerConfig'
import { OAUTH_PROVIDERS, oauthAccessToken } from './oauth'
import { getKey, keyStatus } from './secrets'

/**
 * The provider registry, ported from String Theory. `kind` selects the wire format, not the
 * vendor: every OpenAI-compatible endpoint shares one code path.
 */

/** One opaque value per app run: the relay pins a conversation to one backend with it. */
const RELAY_SESSION = randomUUID()

export interface Provider {
  id: string
  label: string
  kind: 'openai' | 'anthropic' | 'gemini' | 'codex'
  base: string
  needsKey: boolean
  models: string[]
  /** OpenCode's relay answers 400 MissingSessionID without this header. */
  relaySession?: boolean
  /** An OAuth provider carries a signed-in session instead of a pasted key. */
  requiresSignIn?: boolean
}

export const PROVIDERS: Provider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    base: 'https://api.openai.com/v1',
    needsKey: true,
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini']
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    base: 'https://api.anthropic.com/v1',
    needsKey: true,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-3-5']
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta',
    needsKey: true,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash']
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    base: 'https://api.deepseek.com/v1',
    needsKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    needsKey: true,
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1', 'google/gemini-2.5-pro']
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    kind: 'openai',
    base: 'https://api.mistral.ai/v1',
    needsKey: true,
    models: ['mistral-large-latest', 'mistral-small-latest']
  },
  {
    id: 'qwen',
    label: 'Qwen (DashScope)',
    kind: 'openai',
    base: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
    models: ['qwen-max', 'qwen-plus']
  },
  {
    id: 'zai',
    label: 'Z.ai (Coding Plan)',
    kind: 'openai',
    // The coding plan answers on /api/coding/paas/v4; the plain /api/paas/v4 endpoint reports
    // no balance for the same key, which is a routing difference rather than an empty account.
    base: 'https://api.z.ai/api/coding/paas/v4',
    needsKey: true,
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash']
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    kind: 'openai',
    base: 'https://opencode.ai/zen/go/v1',
    needsKey: true,
    relaySession: true,
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3-flash', 'kimi-k2', 'qwen3-coder']
  },
  {
    id: 'xai',
    label: 'xAI',
    kind: 'openai',
    base: 'https://api.x.ai/v1',
    needsKey: true,
    models: ['grok-4', 'grok-3', 'grok-3-mini']
  },
  {
    id: 'local',
    label: 'Local (Ollama / LM Studio)',
    kind: 'openai',
    base: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    models: ['llama3.1', 'qwen2.5-coder']
  }
]

/** The declared provider with any saved base URL or discovered models applied. */
export function providerById(id: string): Provider | undefined {
  const declared = PROVIDERS.find((provider) => provider.id === id)
  if (!declared) return undefined
  const override = getOverride(id)
  return {
    ...declared,
    base: override.base ?? declared.base,
    models: override.models?.length ? override.models : declared.models
  }
}

/** The credential a model listing should carry: a saved key, or an OAuth session. */
function listingToken(providerId: string): string | null {
  // A sign-in wins when it exists, but a provider that supports both must still fall back to a
  // saved API key instead of reporting itself unconfigured.
  const session = OAUTH_PROVIDERS[providerId] ? oauthAccessToken(providerId) : null
  return session ?? getKey(providerId)
}

/**
 * Discover models from the endpoint the credential actually belongs to.
 *
 * A ChatGPT session reads its catalogue from the Codex backend, not from api.openai.com; the
 * request needs `client_version` or it answers 400, and the session must never be sent to the
 * platform base URL. Claude over OAuth needs its beta header. Everything else speaks the plain
 * OpenAI-compatible `{ data: [{ id }] }` shape, which xAI, OpenRouter, Ollama and LM Studio share.
 */
export async function discoverModels(provider: Provider): Promise<{ models: string[] | null; error?: string }> {
  const session = OAUTH_PROVIDERS[provider.id] ? oauthAccessToken(provider.id) : null
  const token = listingToken(provider.id)
  const headers: Record<string, string> = { accept: 'application/json' }
  let url = `${provider.base.replace(/\/$/, '')}/models`

  if (session && provider.id === 'openai') {
    url = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0'
    headers.authorization = `Bearer ${session}`
    headers.originator = 'codex_cli_rs'
    headers['OpenAI-Beta'] = 'responses=experimental'
  } else if (session && provider.kind === 'anthropic') {
    url = `${provider.base.replace(/\/$/, '')}/models?limit=100`
    headers.authorization = `Bearer ${session}`
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-beta'] = 'oauth-2025-04-20'
  } else if (token && provider.kind === 'anthropic') {
    // Anthropic reads an API key from its own header; it does not accept a bearer key.
    headers['x-api-key'] = token
    headers['anthropic-version'] = '2023-06-01'
  } else if (token) {
    headers.authorization = `Bearer ${token}`
  } else {
    return { models: null, error: 'no key or sign-in saved for this provider' }
  }

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    const body = await response.text()
    if (!response.ok) {
      return { models: null, error: `${new URL(url).host} answered ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}` }
    }
    type Listed = { id?: string; name?: string; slug?: string }
    const payload = JSON.parse(body) as { data?: Listed[]; models?: Array<Listed | string> }
    const listed = payload.data ?? payload.models ?? []
    const ids = listed
      .map((entry) => (typeof entry === 'string' ? entry : entry.id ?? entry.slug ?? entry.name))
      .filter((id): id is string => !!id)
    return ids.length ? { models: ids } : { models: null, error: 'the endpoint returned no models' }
  } catch (error) {
    return { models: null, error: (error as Error).message }
  }
}

/** A cached list is reused for 48 hours; `refresh` ignores it. */
const CACHE_HOURS = 48

export function cachedModels(providerId: string): { models: string[]; at: string | null; fresh: boolean } {
  const override = getOverride(providerId)
  const at = override.modelsAt ?? null
  const models = override.models ?? []
  const age = at ? Date.now() - Date.parse(at) : Number.POSITIVE_INFINITY
  return { models, at, fresh: models.length > 0 && age < CACHE_HOURS * 3600_000 }
}

export async function refreshModels(provider: Provider): Promise<{ models: string[]; at: string } | { error: string }> {
  const found = await discoverModels(provider)
  if (!found.models) return { error: found.error ?? `no model list at ${provider.base}/models` }
  const at = new Date().toISOString()
  setOverride(provider.id, { models: found.models, modelsAt: at })
  return { models: found.models, at }
}

/** What the renderer is allowed to know: no key material, ever. */
export function providerSummary(provider: Provider) {
  const resolved = providerById(provider.id) ?? provider
  return {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    base: resolved.base,
    needsKey: provider.needsKey,
    requiresSignIn: provider.requiresSignIn ?? false,
    models: resolved.models,
    /** Local servers move between ports, so their address is a field, not a constant. */
    baseEditable: !provider.needsKey,
    ...keyStatus(provider.id)
  }
}

export interface ChatRequest {
  system?: string
  user: string
  model: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

export interface ChatResult {
  text: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
  ms: number
}

export type ProviderFailure =
  | { kind: 'no-key'; provider: string }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'network'; message: string }

function authHeaders(provider: Provider, key: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (provider.relaySession) headers['x-opencode-session'] = RELAY_SESSION
  if (provider.kind === 'anthropic') {
    if (key) headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
    return headers
  }
  if (key) headers.authorization = `Bearer ${key}`
  return headers
}

export async function chat(provider: Provider, request: ChatRequest): Promise<ChatResult | ProviderFailure> {
  const key = provider.needsKey ? getKey(provider.id) : null
  if (provider.needsKey && !key) return { kind: 'no-key', provider: provider.id }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000)

  try {
    if (provider.kind === 'anthropic') {
      const response = await fetch(`${provider.base}/messages`, {
        method: 'POST',
        headers: authHeaders(provider, key),
        signal: controller.signal,
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature ?? 0.2,
          system: request.system,
          messages: [{ role: 'user', content: request.user }]
        })
      })
      if (!response.ok) return { kind: 'http', status: response.status, body: (await response.text()).slice(0, 500) }
      const payload = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const text = (payload.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
      return {
        text,
        model: request.model,
        inputTokens: payload.usage?.input_tokens ?? null,
        outputTokens: payload.usage?.output_tokens ?? null,
        ms: Date.now() - started
      }
    }

    if (provider.kind === 'gemini') {
      const url = `${provider.base}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(key ?? '')}`
      const response = await fetch(url, {
        method: 'POST',
        headers: authHeaders(provider, key),
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: request.system ? { parts: [{ text: request.system }] } : undefined,
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            temperature: request.temperature ?? 0.2,
            maxOutputTokens: request.maxTokens ?? 1024
          }
        })
      })
      if (!response.ok) return { kind: 'http', status: response.status, body: (await response.text()).slice(0, 500) }
      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
      }
      const text = (payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('')
      return {
        text,
        model: request.model,
        inputTokens: payload.usageMetadata?.promptTokenCount ?? null,
        outputTokens: payload.usageMetadata?.candidatesTokenCount ?? null,
        ms: Date.now() - started
      }
    }

    const messages: Array<{ role: string; content: string }> = []
    if (request.system) messages.push({ role: 'system', content: request.system })
    messages.push({ role: 'user', content: request.user })

    const response = await fetch(`${provider.base}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(provider, key),
      signal: controller.signal,
      body: JSON.stringify({
        model: request.model,
        messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 1024
      })
    })
    if (!response.ok) return { kind: 'http', status: response.status, body: (await response.text()).slice(0, 500) }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    return {
      text: payload.choices?.[0]?.message?.content ?? '',
      model: request.model,
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
      ms: Date.now() - started
    }
  } catch (error) {
    return { kind: 'network', message: (error as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A test is one real request with the smallest possible output, because a key that passes a
 * header check can still be dead and a model name can still be wrong.
 */
export async function testProvider(
  provider: Provider,
  model?: string
): Promise<{ ok: boolean; detail: string; model?: string; ms?: number }> {
  if (provider.needsKey && !getKey(provider.id)) {
    return { ok: false, detail: provider.needsKey ? 'no key saved' : 'unreachable' }
  }
  if (provider.id === 'local') {
    try {
      const response = await fetch(`${provider.base}/models`, { signal: AbortSignal.timeout(3000) })
      return response.ok
        ? { ok: true, detail: 'local server answered' }
        : { ok: false, detail: `local server answered ${response.status}` }
    } catch (error) {
      return { ok: false, detail: `local server unreachable: ${(error as Error).message}` }
    }
  }

  const chosen = model ?? provider.models[0]
  const result = await chat(provider, {
    user: 'Reply with the single word: ok',
    model: chosen,
    maxTokens: 8,
    timeoutMs: 45_000
  })
  if ('kind' in result) {
    if (result.kind === 'http') return { ok: false, detail: `HTTP ${result.status}: ${result.body.slice(0, 160)}`, model: chosen }
    if (result.kind === 'no-key') return { ok: false, detail: 'no key saved', model: chosen }
    return { ok: false, detail: result.message, model: chosen }
  }
  const note = result.text.trim() ? '' : ' (empty text: the model may spend the whole allowance on reasoning)'
  return { ok: true, detail: `answered in ${result.ms} ms${note}`, model: result.model, ms: result.ms }
}
