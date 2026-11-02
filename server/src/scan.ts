import fs from 'node:fs'
import path from 'node:path'
import type { AgentRoot } from './registry'
import { MANIFEST, isLinked } from './placement'
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

/** One agent root's view of a package: the folder it sees, and how it got it. */
export interface PlacementRow {
  realPath: string
  targetPath: string
  mode: 'native' | 'link' | 'copy'
}

export interface RootEntry {
  root: RootScan
  skills: SkillRecord[]
  placements: PlacementRow[]
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
    out.push(dir)
    return
  }
  if (depth >= MAX_DEPTH) return
  for (const entry of entries) {
    // A junction or symlink reports isSymbolicLink(), never isDirectory(): skipping those
    // would hide exactly the placements this index exists to show.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (SKIP.has(entry.name)) continue
    findPackages(path.join(dir, entry.name), depth + 1, out)
  }
}

/** One root, parsed. Used by both the full sweep and the watcher. */
function realPathOf(dir: string): string {
  try {
    return fs.realpathSync.native(dir)
  } catch {
    return dir
  }
}

function modeOf(dir: string): PlacementRow['mode'] {
  if (isLinked(dir)) return 'link'
  try {
    fs.accessSync(path.join(dir, MANIFEST))
    return 'copy'
  } catch {
    return 'native'
  }
}

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
      skills: [],
      placements: []
    }
  }

  const packages: string[] = []
  findPackages(root.path, 0, packages)

  const skills: SkillRecord[] = []
  const placements: PlacementRow[] = []
  const parsed = new Set<string>()

  for (const dir of packages) {
    // Identity is the resolved directory, not the folder the agent happens to see:
    // one package placed in three agents is one skill with three placements.
    const realPath = realPathOf(dir)
    placements.push({ realPath, targetPath: dir, mode: modeOf(dir) })
    if (parsed.has(realPath)) continue
    const record = parseSkill(dir, root.path, root.scope)
    if (!record) continue
    parsed.add(realPath)
    skills.push({ ...record, realPath })
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
    skills,
    placements
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
