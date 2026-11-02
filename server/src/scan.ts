import fs from 'node:fs'
import path from 'node:path'
import type { AgentRoot } from './registry'

const SKIP = new Set(['node_modules', '.git', '.archive', '.cache'])

export interface FoundSkill {
  name: string
  path: string
}

export interface RootScan {
  path: string
  scope: string
  owners: string[]
  exists: boolean
  count: number
  skills: FoundSkill[]
  truncated: boolean
  ms: number
  error?: string
}

const MAX_DEPTH = 3
const MAX_SKILLS = 5000

function walk(dir: string, depth: number, out: FoundSkill[]): void {
  if (out.length >= MAX_SKILLS) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
    out.push({ name: path.basename(dir), path: dir })
    return
  }
  if (depth >= MAX_DEPTH) return

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue
    walk(path.join(dir, entry.name), depth + 1, out)
  }
}

export function scanRoot(root: AgentRoot): RootScan {
  const started = Date.now()
  if (!root.exists) {
    return {
      path: root.path,
      scope: root.scope,
      owners: root.owners,
      exists: false,
      count: 0,
      skills: [],
      truncated: false,
      ms: Date.now() - started,
      error: root.error ?? 'MISSING'
    }
  }

  const skills: FoundSkill[] = []
  walk(root.path, 0, skills)
  return {
    path: root.path,
    scope: root.scope,
    owners: root.owners,
    exists: true,
    count: skills.length,
    skills: skills.slice(0, 50),
    truncated: skills.length >= MAX_SKILLS,
    ms: Date.now() - started
  }
}

export function scanRoots(roots: AgentRoot[]): RootScan[] {
  return roots.filter((r) => r.exists).map(scanRoot)
}
