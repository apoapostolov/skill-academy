import fs from 'node:fs'
import path from 'node:path'
import type { AgentRoot } from './registry'
import { isLinked } from './placement'
import { parseSkill, type SkillRecord } from './skill'

const SKIP = new Set(['node_modules', '.git', '.archive', '.cache'])
const MAX_DEPTH = 3
const MAX_SKILLS_PER_ROOT = 5000

export interface RootScan {
  path: string
  scope: string
  owners: string[]
  exists: boolean
  count: number
  truncated: boolean
  ms: number
  error?: string
}

export interface RootEntry {
  root: RootScan
  skills: SkillRecord[]
}

export interface ScanOutcome {
  entries: RootEntry[]
  skills: number
  ms: number
}

function findPackages(dir: string, depth: number, out: string[]): void {
  if (out.length >= MAX_SKILLS_PER_ROOT) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    // A linked package is a placement of a skill that lives elsewhere: indexing it
    // again would list one skill twice and double its token cost.
    if (!isLinked(dir)) out.push(dir)
    return
  }
  if (depth >= MAX_DEPTH) return
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue
    findPackages(path.join(dir, entry.name), depth + 1, out)
  }
}

/** One root, parsed. Used by both the full sweep and the watcher. */
export function scanOne(root: AgentRoot): RootEntry {
  const started = Date.now()
  if (!root.exists) {
    return {
      root: {
        path: root.path,
        scope: root.scope,
        owners: root.owners,
        exists: false,
        count: 0,
        truncated: false,
        ms: 0,
        error: root.error ?? 'MISSING'
      },
      skills: []
    }
  }

  const packages: string[] = []
  findPackages(root.path, 0, packages)
  const skills: SkillRecord[] = []
  for (const dir of packages) {
    const record = parseSkill(dir, root.path, root.scope)
    if (record) skills.push(record)
  }

  return {
    root: {
      path: root.path,
      scope: root.scope,
      owners: root.owners,
      exists: true,
      count: skills.length,
      truncated: packages.length >= MAX_SKILLS_PER_ROOT,
      ms: Date.now() - started
    },
    skills
  }
}

export function scanAll(roots: AgentRoot[]): ScanOutcome {
  const started = Date.now()
  const entries = roots.filter((root) => root.exists).map(scanOne)
  return {
    entries,
    skills: entries.reduce((sum, entry) => sum + entry.skills.length, 0),
    ms: Date.now() - started
  }
}
