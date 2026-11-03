import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, LIBRARY_DIR } from './config'
import { getDb, lockRows } from './db'
import { parseSkill } from './skill'

export interface LockSkill {
  name: string
  version: string | null
  /** The package folder. Without it a lock names a root, not a package. */
  path: string
  root: string
  hash: string | null
  category: string | null
  tags: string[]
  placements: Array<{ root: string; mode: string; target: string }>
}

export interface LockFile {
  lockVersion: number
  skills: LockSkill[]
}

/** Placements for every row sharing a name: the name is what the lock identifies a skill by. */
export function placementsForName(name: string): Array<{ root: string; mode: string; target: string }> {
  const rows = getDb()
    .prepare(
      `SELECT s.name, p.root_path, p.target_path, p.mode FROM placements p
       JOIN skills s ON s.id = p.skill_id WHERE s.name = ? ORDER BY p.root_path`
    )
    .all(name) as Array<{ root_path: string; target_path: string; mode: string }>
  return rows.map((row) => ({ root: row.root_path, mode: row.mode, target: row.target_path }))
}

/**
 * The packages the library itself holds. The library is deliberately not a scanned root, so its
 * packages are read here or they would be missing from the one document meant to reproduce it.
 */
function libraryEntries(): LockSkill[] {
  if (!fs.existsSync(LIBRARY_DIR)) return []
  const entries: LockSkill[] = []
  for (const entry of fs.readdirSync(LIBRARY_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(LIBRARY_DIR, entry.name)
    const record = parseSkill(dir, LIBRARY_DIR, 'library')
    if (!record) continue
    entries.push({
      name: record.name,
      version: null,
      path: dir,
      root: LIBRARY_DIR,
      hash: record.packageHash,
      category: record.category || null,
      tags: record.tags,
      placements: placementsForName(record.name)
    })
  }
  return entries
}

/** What the lock file says the library is: the scanned roots plus the library's own packages. */
export function lockDocument(): LockFile {
  const rows: LockSkill[] = lockRows().map((row) => ({
    name: row.name,
    version: row.version ?? null,
    path: row.path,
    root: row.root_path,
    hash: row.package_hash ?? null,
    category: row.category ?? null,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    placements: placementsForName(row.name)
  }))
  const seen = new Set(rows.map((row) => row.path))
  for (const entry of libraryEntries()) {
    if (!seen.has(entry.path)) rows.push(entry)
  }
  rows.sort((a, b) => (a.name + a.path).localeCompare(b.name + b.path))
  return { lockVersion: 1, skills: rows }
}

export function defaultLockPath(): string {
  return process.env.SKILL_ACADEMY_LOCK ?? path.join(DATA_DIR, 'skill-academy.lock.json')
}

/** Writes the lock, creating its folder. Returns the path and how many skills it names. */
export function writeLock(target = defaultLockPath()): { path: string; skills: number } {
  const document = lockDocument()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(document, null, 2) + '\n')
  return { path: target, skills: document.skills.length }
}
