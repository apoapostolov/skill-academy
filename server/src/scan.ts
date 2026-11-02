import fs from 'node:fs'
import path from 'node:path'
import type { AgentRoot } from './registry'
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

export interface ScanOutcome {
  roots: RootScan[]
  skills: SkillRecord[]
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
    out.push(dir)
    return
  }
  if (depth >= MAX_DEPTH) return
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue
    findPackages(path.join(dir, entry.name), depth + 1, out)
  }
}

export function scanAll(roots: AgentRoot[]): ScanOutcome {
  const started = Date.now()
  const results: RootScan[] = []
  const skills: SkillRecord[] = []

  for (const root of roots) {
    if (!root.exists) continue
    const rootStarted = Date.now()
    const packages: string[] = []
    findPackages(root.path, 0, packages)

    let parsed = 0
    for (const dir of packages) {
      const record = parseSkill(dir, root.path, root.scope)
      if (!record) continue
      skills.push(record)
      parsed += 1
    }

    results.push({
      path: root.path,
      scope: root.scope,
      owners: root.owners,
      exists: true,
      count: parsed,
      truncated: packages.length >= MAX_SKILLS_PER_ROOT,
      ms: Date.now() - rootStarted
    })
  }

  return { roots: results, skills, ms: Date.now() - started }
}
