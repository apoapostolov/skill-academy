/**
 * The one place that talks to the running service.
 *
 * Both front ends (the `ska` CLI and the MCP server) are thin on purpose: the service owns the
 * library, the journal and the lock, and parity means calling the same routes the browser calls, not
 * re-implementing a second half-truth beside them.
 */

export interface SkillRow {
  id: number
  name: string
  path: string
  root_path: string
  package_hash: string | null
  description: string
  risk: string
  tokens: number
}

export interface RootRow {
  path: string
  scope: string
  owners: string[]
  exists: boolean
}

export const DEFAULT_BASE = process.env.SKILL_ACADEMY_URL ?? 'http://127.0.0.1:10008'

export class ServiceError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message)
  }
}

async function request<T>(base: string, method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(base.replace(/\/$/, '') + path, {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      // A local service that is not running should fail at once, not hang a script for 30 seconds.
      signal: AbortSignal.timeout(120_000)
    })
  } catch (cause) {
    throw new ServiceError(
      `cannot reach the Skill Academy service at ${base} (${(cause as Error).message}). Is it running?`,
      0
    )
  }
  const text = await response.text()
  const body = text ? (JSON.parse(text) as unknown) : {}
  if (!response.ok) {
    const detail = (body as { error?: string; reason?: string }).error ?? (body as { reason?: string }).reason ?? text.slice(0, 200)
    throw new ServiceError(`${method} ${path} -> ${response.status} ${detail}`, response.status, body)
  }
  return body as T
}

export const apiGet = <T>(base: string, path: string): Promise<T> => request<T>(base, 'GET', path)
export const apiPost = <T>(base: string, path: string, payload: unknown = {}): Promise<T> =>
  request<T>(base, 'POST', path, payload)

export async function listSkills(base: string, query = '', limit = 20): Promise<{ total: number; rows: SkillRow[] }> {
  const params = new URLSearchParams({ limit: String(limit), status: 'all' })
  if (query) params.set('q', query)
  return apiGet<{ total: number; rows: SkillRow[] }>(base, `/api/skills?${params.toString()}`)
}

/**
 * A name is resolved to exactly one skill or the call fails with the candidates. Guessing which
 * "pdf" the caller meant is how a script archives the wrong package.
 */
export async function resolveSkill(base: string, name: string): Promise<SkillRow> {
  const { rows } = await listSkills(base, name, 50)
  const exact = rows.filter((row) => row.name === name)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    throw new ServiceError(`"${name}" is ambiguous: ${exact.map((row) => row.path).join(', ')}`)
  }
  const near = rows.slice(0, 8).map((row) => row.name)
  throw new ServiceError(
    near.length ? `no skill named "${name}". Close matches: ${near.join(', ')}` : `no skill named "${name}"`
  )
}

export async function agentsForRoot(base: string, rootPath: string): Promise<string[]> {
  const { roots } = await apiGet<{ roots: RootRow[] }>(base, '/api/roots')
  const root = roots.find((entry) => entry.path.toLowerCase() === rootPath.toLowerCase())
  return (root?.owners ?? []).filter(Boolean)
}

export interface SwitchResult {
  ok?: boolean
  on?: boolean
  agent?: string
  path?: string
  error?: string
}

/** Enabling and disabling go through the same route the UI's switch calls, so the journal agrees. */
export async function setEnabled(
  base: string,
  name: string,
  on: boolean,
  agent?: string
): Promise<Array<{ agent: string; result: SwitchResult }>> {
  const skill = await resolveSkill(base, name)
  const owners = await agentsForRoot(base, skill.root_path)
  if (!owners.length) throw new ServiceError(`no detected agent owns ${skill.root_path}`)
  const targets = agent ? owners.filter((owner) => owner === agent) : owners
  if (!targets.length) throw new ServiceError(`${agent} does not own ${skill.root_path} (owners: ${owners.join(', ')})`)
  const results: Array<{ agent: string; result: SwitchResult }> = []
  for (const target of targets) {
    const result = await apiPost<SwitchResult>(base, `/api/skills/${skill.id}/switch`, { agent: target, on })
    results.push({ agent: target, result })
  }
  return results
}

export interface LockCheck {
  ok: boolean
  path: string
  added: string[]
  removed: string[]
  changed: string[]
}

export const checkLock = (base: string, lockPath?: string): Promise<LockCheck> =>
  apiPost<LockCheck>(base, '/api/lock/check', lockPath ? { path: lockPath } : {})
