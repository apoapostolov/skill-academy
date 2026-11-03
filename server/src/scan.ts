import fs from 'node:fs'
import path from 'node:path'
import type { AgentRoot } from './registry'
import { MANIFEST, isLinked } from './placement'
import { addLibraryPaths, applyReferenceIndex, parseSkill, resetLibraryPaths, type SkillRecord } from './skill'

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

/**
 * Packages, not visits. The same folder can be registered under more than one root, and the index
 * keeps one row per package, so summing per-root counts would report a library larger than it is.
 */
export function countPackages(entries: RootEntry[]): number {
  const seen = new Set<string>()
  for (const entry of entries) {
    for (const skill of entry.skills) seen.add((skill.realPath ?? skill.path).toLowerCase())
  }
  return seen.size
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

  // `.archive` is where a skill goes when it is switched off for this platform: still on disk,
  // still indexed, just no longer in the agent's skill folder.
  const archivedPackages: string[] = []
  findPackages(path.join(root.path, '.archive'), 1, archivedPackages)

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

  for (const dir of archivedPackages) {
    if (parsed.has(realPathOf(dir))) continue
    const record = parseSkill(dir, root.path, root.scope)
    if (!record) continue
    parsed.add(realPathOf(dir))
    skills.push({ ...record, realPath: realPathOf(dir) })
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

/** Serial scan. The fallback, and what a single root needs. */
export function scanAllSync(roots: AgentRoot[]): ScanOutcome {
  const started = Date.now()
  const entries = roots.filter((root) => root.exists).map(scanOne)
  return {
    entries,
    skills: countPackages(entries),
    ms: Date.now() - started
  }
}

/**
 * Parsing a skill is read, tokenise, scan: two thirds of it is CPU that one thread cannot share,
 * so a cold scan over twenty roots uses the cores it has. Any worker failure falls back to the
 * serial path rather than answering with a short library.
 */
export async function scanAll(roots: AgentRoot[]): Promise<ScanOutcome> {
  const started = Date.now()
  const live = roots.filter((root) => root.exists)
  if (live.length < 3 || process.env.SKILL_ACADEMY_SERIAL_SCAN === '1') {
    const serial = scanAllSync(live)
    return { ...serial, ms: Date.now() - started }
  }

  const { Worker } = await import('node:worker_threads')
  const { cpus } = await import('node:os')
  const cap = Number(process.env.SKILL_ACADEMY_SCAN_LANES ?? '') || Math.min(10, Math.max(1, cpus().length - 1))
  const lanes = Math.max(1, Math.min(live.length, cap))
  const chunks: AgentRoot[][] = Array.from({ length: lanes }, () => [])
  live.forEach((root, index) => chunks[index % lanes].push(root))
  const workerUrl = new URL('./scanWorker.ts', import.meta.url)

  const runLane = (chunk: AgentRoot[]): Promise<RootEntry[]> =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, {
        execArgv: ['--import', 'tsx'],
        workerData: { roots: chunk }
      })
      let settled = false
      worker.on('message', (entries: RootEntry[]) => {
        settled = true
        resolve(entries)
        void worker.terminate()
      })
      worker.on('error', (error) => {
        if (!settled) reject(error)
      })
      worker.on('exit', (code) => {
        if (!settled) reject(new Error(`scan worker exited ${code}`))
      })
    })

  try {
    const lanesOfEntries = await Promise.all(chunks.map(runLane))
    // Keep the registry's order: the screen lists roots the way the registry does.
    const byPath = new Map(lanesOfEntries.flat().map((entry) => [entry.root.path, entry]))
    const entries = live.map((root) => byPath.get(root.path)).filter((entry): entry is RootEntry => Boolean(entry))
    return {
      entries,
      skills: countPackages(entries),
      ms: Date.now() - started
    }
  } catch {
    const serial = scanAllSync(live)
    return { ...serial, ms: Date.now() - started }
  }
}
