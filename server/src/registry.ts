import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from './config'

export type Scope = 'global' | 'project'

export interface RegistryRow {
  agents: string[]
  label: string
  project: string
  global: string
}

export interface AgentRoot {
  /** Absolute path, the identity of the root. */
  path: string
  scope: Scope
  /** Agent codes that read this root. Several agents often share one directory. */
  owners: string[]
  exists: boolean
  /** `registry` when it came from skills.sh's table, `host` when detected on this machine. */
  origin: 'registry' | 'host'
  error?: string
}

export interface RegistrySummary {
  rows: number
  codes: number
  roots: AgentRoot[]
}

function expand(raw: string): string | null {
  const value = raw.replace(/`/g, '').trim()
  if (!value) return null
  if (/^n\/?a/i.test(value)) return null
  const expanded = value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value
  if (!path.isAbsolute(expanded)) return null
  return path.resolve(expanded)
}

function keyFor(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * The public registry knows where an agent looks on a default install, not where it
 * looks on this host. Hermes is the clear case: the table says `~/.hermes/skills`,
 * while a native Windows install keeps 341 skills under HERMES_HOME.
 */
function addHostRoots(byPath: Map<string, AgentRoot>): void {
  const candidates: { path: string; owners: string[] }[] = []
  if (process.env.HERMES_HOME) {
    candidates.push({ path: path.join(process.env.HERMES_HOME, 'skills'), owners: ['hermes-agent'] })
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push({ path: path.join(process.env.LOCALAPPDATA, 'hermes', 'skills'), owners: ['hermes-agent'] })
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path)
    const key = keyFor(resolved)
    const existing = byPath.get(key)
    if (existing) {
      existing.origin = existing.origin === 'registry' ? 'registry' : existing.origin
      continue
    }
    byPath.set(key, {
      path: resolved,
      scope: 'global',
      owners: candidate.owners,
      exists: false,
      origin: 'host'
    })
  }
}

export function loadRegistry(): RegistrySummary {
  const file = path.join(REPO_ROOT, 'registry', 'agents.json')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: RegistryRow[] }
  const byPath = new Map<string, AgentRoot>()
  const codes = new Set<string>()

  for (const row of parsed.rows) {
    for (const code of row.agents) codes.add(code)
    const target = expand(row.global)
    if (!target) continue
    const key = keyFor(target)
    const existing = byPath.get(key)
    if (existing) {
      for (const code of row.agents) if (!existing.owners.includes(code)) existing.owners.push(code)
      continue
    }
    byPath.set(key, { path: target, scope: 'global', owners: [...row.agents], exists: false, origin: 'registry' })
  }

  addHostRoots(byPath)

  // A test run can point the whole index at fixtures instead of the live agent roots, which is how
  // consolidation and curation are exercised without touching a real skill library.
  const only = process.env.SKILL_ACADEMY_ONLY_ROOTS
  if (only) {
    byPath.clear()
    for (const entry of only.split(',').map((value) => value.trim()).filter(Boolean)) {
      const target = path.resolve(entry)
      byPath.set(keyFor(target), { path: target, scope: 'global', owners: ['fixture'], exists: false, origin: 'host' })
    }
  }

  const roots = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  for (const root of roots) {
    try {
      root.exists = fs.statSync(root.path).isDirectory()
    } catch (error) {
      root.exists = false
      root.error = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
    }
  }

  return { rows: parsed.rows.length, codes: codes.size, roots }
}
