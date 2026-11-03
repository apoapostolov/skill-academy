export interface RegistryAudit {
  provider: string
  status: 'pass' | 'warn' | 'fail' | string
  risk: string | null
  summary: string
  auditedAt: string | null
}

export interface RegistryVerdict {
  id: string
  source: string
  skill: string
  /** The worst status any provider reported: a pass from one auditor does not outvote a fail from another. */
  verdict: 'pass' | 'warn' | 'fail' | 'unknown'
  audits: RegistryAudit[]
}

const BASE = 'https://skills.sh/api/v1/skills/audit'

/**
 * A skills.sh entry is `owner/repo` for a repository or `owner/repo/skill` for one skill. The repo
 * segment is always two parts, which is what makes a three-part entry unambiguous.
 */
export function parseEntry(entry: string): { source: string; skill: string | null } | null {
  const trimmed = entry.trim().replace(/^https?:\/\/skills\.sh\//i, '').replace(/\/+$/, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length < 2 || parts.length > 3) return null
  if (!parts.every((part) => /^[\w.-]+$/.test(part))) return null
  return { source: `${parts[0]}/${parts[1]}`, skill: parts[2] ?? null }
}

function normaliseStatus(status: string | undefined): 'pass' | 'warn' | 'fail' | 'unknown' {
  const value = (status ?? '').toLowerCase()
  if (value === 'pass' || value === 'warn' || value === 'fail') return value
  return 'unknown'
}

/** Turns the registry's payload into our own shape, worst status first, without inventing a score. */
export function summariseAudit(payload: unknown): RegistryVerdict | null {
  if (!payload || typeof payload !== 'object') return null
  const row = payload as { id?: string; source?: string; slug?: string; audits?: unknown[] }
  if (!Array.isArray(row.audits)) return null
  const audits: RegistryAudit[] = row.audits.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>
    return {
      provider: String(item.provider ?? 'unknown'),
      status: normaliseStatus(item.status as string | undefined),
      risk: item.riskLevel ? String(item.riskLevel) : null,
      summary: String(item.summary ?? ''),
      auditedAt: item.auditedAt ? String(item.auditedAt) : null
    }
  })
  const order = { fail: 3, warn: 2, pass: 1, unknown: 0 } as const
  const worst = audits.reduce<'pass' | 'warn' | 'fail' | 'unknown'>((current, audit) => {
    const status = normaliseStatus(audit.status)
    return order[status] > order[current] ? status : current
  }, 'pass')
  return {
    id: String(row.id ?? `${row.source ?? ''}/${row.slug ?? ''}`),
    source: String(row.source ?? ''),
    skill: String(row.slug ?? ''),
    verdict: audits.length ? worst : 'unknown',
    audits: audits.sort((a, b) => order[normaliseStatus(b.status)] - order[normaliseStatus(a.status)])
  }
}

/**
 * Reads one skill's verdict from the public audit endpoint. The catalog endpoints need a Vercel OIDC
 * token; this one does not, which is why the registry's own verdict is the part we can show.
 */
export async function fetchAudit(source: string, skill: string): Promise<RegistryVerdict | null> {
  const response = await fetch(`${BASE}/${source}/${skill}`, {
    headers: { accept: 'application/json', 'user-agent': 'skill-academy' }
  })
  if (!response.ok) return null
  return summariseAudit(await response.json())
}
