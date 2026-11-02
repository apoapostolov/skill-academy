import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { deleteKey, deleteLongSecret, getKey, getLongSecret, setKey, setLongSecret } from './secrets'

/**
 * OAuth sessions, ported from String Theory's `server/oauth.mjs` with the same flows, client ids
 * and endpoints, because those are the ones the providers accept. Provider-specific detail lives
 * in the table below; everything else is one device code, one token exchange, one refresh.
 *
 * Sessions are sealed in the OS credential store as one JSON value per provider, so an access
 * token never touches the index, a log or a response body. The renderer learns that a session
 * exists, which account it belongs to, and when it expires.
 */

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const MIN_INTERVAL = 3
const AUTHORIZE_TTL = 15 * 60 * 1000

type FlowKind = 'device' | 'codex' | 'authorize'

interface OAuthConfig {
  label: string
  kind: FlowKind
  clientId: string
  scope?: string
  deviceEndpoint?: string
  pollEndpoint?: string
  authorizeEndpoint?: string
  redirectUri?: string
  tokenEndpoint: string
  verificationFallback?: string
  authorizeParams?: Record<string, string>
  tokenStyle?: 'json'
  note: string
  allowsTokenImport: boolean
}

export const OAUTH_PROVIDERS: Record<string, OAuthConfig> = {
  xai: {
    label: 'xAI',
    kind: 'device',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    scope: 'openid profile email offline_access grok-cli:access api:access',
    deviceEndpoint: 'https://auth.x.ai/oauth2/device/code',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    verificationFallback: 'https://accounts.x.ai/oauth2/device',
    note: 'Sign in with the xAI account that has Grok access. The access token is used as a bearer token against api.x.ai.',
    allowsTokenImport: true
  },
  anthropic: {
    label: 'Claude',
    kind: 'authorize',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scope: 'org:create_api_key user:profile user:inference',
    authorizeEndpoint: 'https://claude.ai/oauth/authorize',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
    authorizeParams: { code: 'true' },
    tokenStyle: 'json',
    note: 'Sign in with the Claude account behind your subscription, approve in the browser, and paste the code it shows you.',
    allowsTokenImport: true
  },
  openai: {
    label: 'ChatGPT (Codex)',
    kind: 'codex',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    deviceEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    pollEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/token',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    redirectUri: 'https://auth.openai.com/deviceauth/callback',
    verificationFallback: 'https://auth.openai.com/codex/device',
    note: 'Sign in with the ChatGPT account behind a Codex subscription. Requests go to the Codex endpoint with that session, not to a platform API key.',
    allowsTokenImport: true
  }
}

export interface OAuthSession {
  access: string
  refresh: string
  expiresAt: string
  account: string
  mode: 'device' | 'authorize' | 'token'
}

/** In-flight codes live in memory: a restart means starting again. */
const pending = new Map<
  string,
  { providerId: string; deviceCode?: string; userCode?: string; verifier?: string; kind: FlowKind; interval: number; expiresAt: number }
>()

const SESSION_KEY = (id: string) => `oauth:${id}`

function fail(message: string, status = 400, code: string | null = null) {
  return Object.assign(new Error(message), { status, code })
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

async function postJson(url: string, payload: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000)
  })
  const text = await response.text()
  let body: Record<string, unknown> | null = null
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = null
  }
  return { ok: response.ok, status: response.status, body, text }
}

async function postForm(url: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(20_000)
  })
  const text = await response.text()
  let body: Record<string, unknown> | null = null
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = null
  }
  return { ok: response.ok, status: response.status, body, text }
}

function postToken(config: OAuthConfig, payload: Record<string, string>) {
  return config.tokenStyle === 'json' ? postJson(config.tokenEndpoint, payload) : postForm(config.tokenEndpoint, payload)
}

/** Best-effort account label, read from the id token without verifying it. */
function accountFromTokens(body: Record<string, unknown> | null): string {
  const described = body?.account as Record<string, unknown> | undefined
  if (described && typeof described === 'object') {
    const label = described.email_address ?? described.email ?? described.uuid ?? ''
    if (label) return String(label)
  }
  const jwt = body?.id_token
  if (typeof jwt !== 'string' || jwt.split('.').length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>
    return String(payload.email ?? payload.preferred_username ?? payload.sub ?? '')
  } catch {
    return ''
  }
}

function expiresAtFrom(body: Record<string, unknown> | null, fallbackSeconds = 3600): string {
  const seconds = Number(body?.expires_in ?? fallbackSeconds)
  return new Date(Date.now() + Math.max(60, Number.isFinite(seconds) ? seconds : fallbackSeconds) * 1000).toISOString()
}

/* ------------------------------- session store ------------------------------- */

function readSession(providerId: string): OAuthSession | null {
  const raw = getLongSecret(SESSION_KEY(providerId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthSession
  } catch {
    return null
  }
}

function writeSession(providerId: string, session: OAuthSession): void {
  // A Codex session is bigger than one Windows credential can hold, so it is stored in parts.
  setLongSecret(SESSION_KEY(providerId), JSON.stringify(session))
}

function clearSession(providerId: string): void {
  deleteLongSecret(SESSION_KEY(providerId))
}

/** What the renderer is allowed to know about a session. Never the tokens. */
/**
 * The poll loop lives here, not in the renderer. A device flow completes whether or not the dialog
 * is still open, so the answer is written to the credential store by the server and the panel only
 * reads the result.
 */
const watch = new Map<string, { status: string; account: string; message: string; at: number }>()

export function watchStatus(providerId: string) {
  return watch.get(providerId) ?? null
}

export function startWatch(providerId: string, flowId: string, intervalSeconds: number): void {
  const interval = Math.max(3, intervalSeconds) * 1000
  let attempt = 0
  const tick = async () => {
    attempt += 1
    if (attempt > 200) {
      watch.set(providerId, { status: 'expired', account: '', message: 'Stopped waiting after ten minutes.', at: Date.now() })
      return
    }
    try {
      const result = await pollDeviceFlow(providerId, flowId)
      if (result.status === 'pending') {
        // Recorded so the panel can show that the server is still listening, not just idle.
        watch.set(providerId, { status: 'pending', account: '', message: '', at: Date.now() })
        setTimeout(tick, (result.interval ?? Math.max(3, intervalSeconds)) * 1000)
        return
      }
      watch.set(providerId, {
        status: result.status,
        account: 'account' in result ? String(result.account ?? '') : '',
        message: 'message' in result ? String(result.message ?? '') : '',
        at: Date.now()
      })
    } catch (error) {
      watch.set(providerId, { status: 'error', account: '', message: String((error as Error).message ?? error), at: Date.now() })
    }
  }
  setTimeout(tick, interval)
}

export function publicOAuthProviders() {
  return Object.entries(OAUTH_PROVIDERS).map(([id, config]) => {
    const session = readSession(id)
    const seen = watchStatus(id)
    return {
      id,
      label: config.label,
      kind: config.kind,
      note: config.note,
      allowsTokenImport: config.allowsTokenImport,
      connected: !!session,
      account: session?.account ?? '',
      expiresAt: session?.expiresAt ?? null,
      mode: session?.mode ?? null,
      watch: seen ? { status: seen.status, account: seen.account, message: seen.message } : null
    }
  })
}

export function oauthAccessToken(providerId: string): string | null {
  const session = readSession(providerId)
  if (!session) return null
  const expires = session.expiresAt ? Date.parse(session.expiresAt) : 0
  if (session.access && (!expires || expires > Date.now() + 60_000)) return session.access
  return session.access || null
}

export function disconnectOAuth(providerId: string): boolean {
  const had = !!readSession(providerId)
  clearSession(providerId)
  return had
}

/* --------------------------------- flows --------------------------------- */

export async function startDeviceFlow(providerId: string) {
  const config = OAUTH_PROVIDERS[providerId]
  if (!config || (config.kind !== 'device' && config.kind !== 'codex')) {
    throw fail(`${providerId} has no device login`, 400, 'no-oauth')
  }

  const result =
    config.kind === 'codex'
      ? await postJson(config.deviceEndpoint!, { client_id: config.clientId })
      : await postForm(config.deviceEndpoint!, { client_id: config.clientId, scope: config.scope ?? '' })

  if (!result.ok || !result.body) {
    throw fail(`${config.label} device login could not start (${result.status}): ${result.text.slice(0, 200)}`, 502, 'device-start')
  }

  const body = result.body as Record<string, unknown>
  const deviceCode = String(body.device_code ?? body.deviceCode ?? body.device_auth_id ?? '')
  const userCode = String(body.user_code ?? body.userCode ?? body.usercode ?? '')
  if (!deviceCode || !userCode) throw fail(`${config.label} did not return a device code.`, 502, 'device-start')

  const interval = Math.max(MIN_INTERVAL, Number(body.interval) || 5)
  const expiresIn = Math.max(60, Number(body.expires_in) || 1800)
  const flowId = randomUUID()
  const expiresAt = Date.now() + expiresIn * 1000
  pending.set(flowId, { providerId, deviceCode, userCode, kind: config.kind, interval, expiresAt })

  return {
    flowId,
    userCode,
    verificationUri: String(body.verification_uri ?? body.verificationUri ?? body.verification_url ?? config.verificationFallback ?? ''),
    verificationUriComplete: String(body.verification_uri_complete ?? body.verificationUriComplete ?? ''),
    interval,
    expiresAt: new Date(expiresAt).toISOString()
  }
}

export async function pollDeviceFlow(providerId: string, flowId: string) {
  const config = OAUTH_PROVIDERS[providerId]
  if (!config) throw fail(`${providerId} has no OAuth login`, 400, 'no-oauth')

  const flow = pending.get(flowId)
  if (!flow || flow.providerId !== providerId) return { status: 'expired', message: 'That login attempt is gone. Start again.' }
  if (flow.expiresAt <= Date.now()) {
    pending.delete(flowId)
    return { status: 'expired', message: 'The code expired before it was approved. Start again.' }
  }

  if (config.kind === 'codex') {
    const polled = await postJson(config.pollEndpoint!, { device_auth_id: flow.deviceCode, user_code: flow.userCode })
    const body = (polled.body ?? {}) as Record<string, unknown>
    const authorizationCode = body.authorization_code
    if (polled.ok && authorizationCode) {
      const exchanged = await postForm(config.tokenEndpoint, {
        grant_type: 'authorization_code',
        code: String(authorizationCode),
        code_verifier: String(body.code_verifier ?? ''),
        redirect_uri: config.redirectUri ?? '',
        client_id: config.clientId
      })
      const token = (exchanged.body ?? {}).access_token
      if (!exchanged.ok || !token) {
        pending.delete(flowId)
        return { status: 'error', message: `${config.label} refused the sign-in (${exchanged.status}).` }
      }
      pending.delete(flowId)
      const saved: OAuthSession = {
        access: String(token),
        refresh: String((exchanged.body ?? {}).refresh_token ?? ''),
        expiresAt: expiresAtFrom(exchanged.body),
        account: accountFromTokens(exchanged.body),
        mode: 'device'
      }
      writeSession(providerId, saved)
      return { status: 'connected', account: saved.account, expiresAt: saved.expiresAt }
    }
    const pendingError = String(body.error ?? '')
    if (polled.status === 403 || polled.status === 404 || pendingError === 'authorization_pending') {
      return { status: 'pending', interval: flow.interval }
    }
    if (pendingError === 'slow_down') {
      flow.interval += 5
      return { status: 'pending', interval: flow.interval }
    }
    if (pendingError === 'access_denied' || pendingError === 'expired_token') {
      pending.delete(flowId)
      return { status: 'denied', message: 'The code was declined or expired. Start again.' }
    }
    return { status: 'error', message: `Sign-in failed (${polled.status}).` }
  }

  const result = await postForm(config.tokenEndpoint, {
    grant_type: DEVICE_GRANT,
    device_code: flow.deviceCode ?? '',
    client_id: config.clientId
  })

  const access = (result.body ?? {}).access_token
  if (result.ok && access) {
    pending.delete(flowId)
    const saved: OAuthSession = {
      access: String(access),
      refresh: String((result.body ?? {}).refresh_token ?? ''),
      expiresAt: expiresAtFrom(result.body),
      account: accountFromTokens(result.body),
      mode: 'device'
    }
    writeSession(providerId, saved)
    return { status: 'connected', account: saved.account, expiresAt: saved.expiresAt }
  }

  const body = (result.body ?? {}) as Record<string, unknown>
  const error = String(body.error ?? '')
  const description = String(body.error_description ?? body.message ?? '')
  switch (error) {
    case 'authorization_pending':
      return { status: 'pending', interval: flow.interval }
    case 'slow_down':
      flow.interval += 5
      return { status: 'pending', interval: flow.interval }
    case 'expired_token':
      pending.delete(flowId)
      return { status: 'expired', message: 'The code expired. Start again.' }
    case 'access_denied':
      pending.delete(flowId)
      return { status: 'denied', message: description || 'The login was denied.' }
    default:
      return { status: 'error', message: description || error || `${config.label} login failed (${result.status}).` }
  }
}

/**
 * Browser sign-in: the provider approves in its own page and shows a code instead of calling back
 * to this machine, so the flow ends with the code pasted here. PKCE S256, and the state is the
 * verifier, which is the shape the provider's own desktop client uses.
 */
export function startAuthorizeFlow(providerId: string) {
  const config = OAUTH_PROVIDERS[providerId]
  if (!config || config.kind !== 'authorize') throw fail(`${providerId} has no browser sign-in`, 400, 'no-oauth')

  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const url = new URL(config.authorizeEndpoint!)
  for (const [name, value] of Object.entries(config.authorizeParams ?? {})) url.searchParams.set(name, value)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', config.redirectUri ?? '')
  url.searchParams.set('scope', config.scope ?? '')
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', verifier)

  const flowId = randomUUID()
  const expiresAt = Date.now() + AUTHORIZE_TTL
  pending.set(flowId, { providerId, verifier, kind: 'authorize', interval: 0, expiresAt })
  return { flowId, url: url.toString(), expiresAt: new Date(expiresAt).toISOString() }
}

export async function completeAuthorizeFlow(providerId: string, flowId: string, pasted: string) {
  const config = OAUTH_PROVIDERS[providerId]
  if (!config || config.kind !== 'authorize') throw fail(`${providerId} has no browser sign-in`, 400, 'no-oauth')

  const flow = pending.get(flowId)
  if (!flow || flow.providerId !== providerId || flow.kind !== 'authorize') {
    throw fail('That sign-in attempt is gone. Start again.', 400, 'flow-gone')
  }
  if (flow.expiresAt <= Date.now()) {
    pending.delete(flowId)
    throw fail('The sign-in expired before it was finished. Start again.', 400, 'flow-expired')
  }

  const raw = pasted.trim()
  if (!raw) throw fail('Paste the code the browser showed you.', 400, 'no-code')
  const [code, state] = raw.split('#', 2)
  if (!code) throw fail('That does not look like an authorization code.', 400, 'bad-code')
  if (state && state !== flow.verifier) throw fail('The authorization state does not match. Start sign-in again.', 400, 'state-mismatch')

  const result = await postToken(config, {
    grant_type: 'authorization_code',
    code,
    state: flow.verifier ?? '',
    client_id: config.clientId,
    redirect_uri: config.redirectUri ?? '',
    code_verifier: flow.verifier ?? ''
  })

  const access = (result.body ?? {}).access_token
  if (!result.ok || !access) {
    const detail = String((result.body ?? {}).error_description ?? (result.body ?? {}).error ?? result.text ?? '').slice(0, 200)
    throw fail(`${config.label} did not accept that code (${result.status}): ${detail}`, 502, 'exchange-failed')
  }

  pending.delete(flowId)
  const session: OAuthSession = {
    access: String(access),
    refresh: String((result.body ?? {}).refresh_token ?? ''),
    expiresAt: expiresAtFrom(result.body),
    account: accountFromTokens(result.body),
    mode: 'authorize'
  }
  writeSession(providerId, session)
  return { status: 'connected', account: session.account, expiresAt: session.expiresAt }
}

/** A token the operator already holds, for whatever the browser handoff cannot reach. */
export function importToken(providerId: string, input: { access?: string; refresh?: string; expiresAt?: string }) {
  const config = OAUTH_PROVIDERS[providerId]
  if (!config) throw fail(`${providerId} has no OAuth login`, 400, 'no-oauth')
  const token = String(input.access ?? '').trim()
  if (token.length < 20) throw fail('That does not look like an access token.', 400, 'bad-token')

  let expires = String(input.expiresAt ?? '').trim()
  if (expires) {
    const parsed = Date.parse(expires)
    expires = Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
  }
  if (!expires) expires = new Date(Date.now() + 3600 * 1000).toISOString()

  writeSession(providerId, {
    access: token,
    refresh: String(input.refresh ?? '').trim(),
    expiresAt: expires,
    account: '',
    mode: 'token'
  })
  return { connected: true, expiresAt: expires }
}

/** The ChatGPT account id travels as its own header on Codex requests. */
export function accountIdFromToken(token: string): string {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    return String(auth?.chatgpt_account_id ?? '')
  } catch {
    return ''
  }
}
