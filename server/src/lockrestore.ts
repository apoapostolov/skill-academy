import fs from 'node:fs'
import path from 'node:path'
import { getDb, removeByPath, saveOne } from './db'
import { parseSkill } from './skill'

export interface LockEntry {
  name: string
  version?: string | null
  path?: string
  root: string
  hash?: string | null
  category?: string | null
  tags?: string[]
  placements?: Array<{ root: string; mode: string; target: string }>
}

export interface LockDocument {
  lockVersion?: number
  skills?: LockEntry[]
}

export interface RestoreResult {
  lockVersion: number | null
  skills: number
  matched: string[]
  missing: string[]
  diverged: Array<{ name: string; root: string; expected: string | null; actual: string }>
  placementsWritten: number
  pruned: string[]
  applied: boolean
}

/**
 * Rebuilds an index from a lock file rather than from a scan: the packages are taken to be on disk
 * already, and each one is verified against the hash the lock recorded.
 *
 * This is the second-machine path, and the path a pull takes after it has written the shared tree.
 * It writes only rows the lock names, reports every package whose bytes disagree, and never pretends
 * a missing package is installed.
 */
export function restoreFromLock(
  lockFile: string,
  options: { apply?: boolean; prune?: boolean } = {}
): RestoreResult | { error: string } {
  if (!fs.existsSync(lockFile)) return { error: 'no-lockfile' }
  let document: LockDocument
  try {
    document = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as LockDocument
  } catch (error) {
    return { error: `unreadable-lock: ${(error as Error).message}` }
  }
  const entries = document.skills ?? []
  const result: RestoreResult = {
    lockVersion: document.lockVersion ?? null,
    skills: entries.length,
    matched: [],
    missing: [],
    diverged: [],
    placementsWritten: 0,
    pruned: [],
    applied: options.apply === true
  }

  for (const entry of entries) {
    // A lock written before the path was recorded named only the root, and the package is the one
    // named after the skill inside it.
    const dir = entry.path ?? path.join(entry.root, entry.name)
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
      result.missing.push(`${entry.name}@${dir}`)
      continue
    }
    // The same read the scan performs, so the hash compared is the hash the lock recorded.
    const record = parseSkill(dir, path.dirname(dir), 'lock')
    if (!record) {
      result.missing.push(`${entry.name}@${dir}`)
      continue
    }
    if (entry.hash && record.packageHash !== entry.hash) {
      result.diverged.push({ name: entry.name, root: dir, expected: entry.hash, actual: record.packageHash })
      continue
    }
    result.matched.push(`${entry.name}@${dir}`)
    if (options.apply !== true) continue
    saveOne(path.dirname(dir), 'lock', record)
    for (const placement of entry.placements ?? []) {
      const skill = getDb().prepare('SELECT id FROM skills WHERE path = ?').get(dir) as { id: number } | undefined
      if (!skill) continue
      getDb()
        .prepare(
          `INSERT INTO placements (skill_id, root_path, target_path, mode, seen_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(skill_id, root_path) DO UPDATE SET target_path = excluded.target_path, mode = excluded.mode, seen_at = excluded.seen_at`
        )
        .run(skill.id, placement.root, placement.target, placement.mode, new Date().toISOString())
      result.placementsWritten += 1
    }
  }

  if (options.prune === true) {
    const unlisted = (getDb().prepare('SELECT name, path FROM skills').all() as Array<{ name: string; path: string }>).filter(
      (row) => !entries.some((entry) => (entry.path ?? path.join(entry.root, entry.name)) === row.path)
    )
    for (const row of unlisted) removeByPath(row.path)
    result.pruned = unlisted.map((row) => row.name)
  }
  return result
}
