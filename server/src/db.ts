import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './config'
import type { SkillRecord } from './skill'
import type { RootScan } from './scan'

export interface RootRow {
  path: string
  scope: string
  owners: string
  present: number
  skill_count: number
  truncated: number
  last_scan_at: string | null
  error: string | null
}

export interface SkillRow {
  id: number
  path: string
  name: string
  description: string
  root_path: string
  scope: string
  body_chars: number
  tokens: number
  tags: string
  package_hash: string
  mtime: string
  files: number
  bytes: number
  health: string
}

export interface SkillQuery {
  q?: string
  root?: string
  tag?: string
  health?: boolean
  limit?: number
  offset?: number
}

/** Bump when the FTS or table shape changes; the index is rebuildable, so it is dropped. */
const SCHEMA_VERSION = 2

let database: DatabaseSync | undefined

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roots (
      path          TEXT PRIMARY KEY,
      scope         TEXT NOT NULL,
      owners        TEXT NOT NULL,
      present       INTEGER NOT NULL,
      skill_count   INTEGER NOT NULL DEFAULT 0,
      truncated     INTEGER NOT NULL DEFAULT 0,
      last_scan_at  TEXT,
      error         TEXT
    );
    CREATE TABLE IF NOT EXISTS skills (
      id            INTEGER PRIMARY KEY,
      path          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      root_path     TEXT NOT NULL,
      scope         TEXT NOT NULL,
      body_chars    INTEGER NOT NULL DEFAULT 0,
      tokens        INTEGER NOT NULL DEFAULT 0,
      tags          TEXT NOT NULL DEFAULT '[]',
      package_hash  TEXT NOT NULL DEFAULT '',
      mtime         TEXT NOT NULL DEFAULT '',
      files         INTEGER NOT NULL DEFAULT 0,
      bytes         INTEGER NOT NULL DEFAULT 0,
      health        TEXT NOT NULL DEFAULT '[]',
      seen_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skills_root ON skills(root_path);
    CREATE INDEX IF NOT EXISTS skills_name ON skills(name COLLATE NOCASE);
  `)

  const stored = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value?: string }
    | undefined
  if (Number(stored?.value ?? 0) !== SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS skills_fts;')
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(name, description, tags, body, content='');`)
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(SCHEMA_VERSION)
  )
}

export function getDb(): DatabaseSync {
  if (!database) {
    database = new DatabaseSync(DB_PATH)
    migrate(database)
  }
  return database
}

export function saveScan(roots: RootScan[], skills: SkillRecord[]): string {
  const db = getDb()
  const at = new Date().toISOString()

  const upsertRoot = db.prepare(`
    INSERT INTO roots (path, scope, owners, present, skill_count, truncated, last_scan_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      scope = excluded.scope, owners = excluded.owners, present = excluded.present,
      skill_count = excluded.skill_count, truncated = excluded.truncated,
      last_scan_at = excluded.last_scan_at, error = excluded.error
  `)
  const upsertSkill = db.prepare(`
    INSERT INTO skills (path, name, description, root_path, scope, body_chars, tokens, tags,
                        package_hash, mtime, files, bytes, health, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name, description = excluded.description, root_path = excluded.root_path,
      scope = excluded.scope, body_chars = excluded.body_chars, tokens = excluded.tokens,
      tags = excluded.tags, package_hash = excluded.package_hash, mtime = excluded.mtime,
      files = excluded.files, bytes = excluded.bytes, health = excluded.health,
      seen_at = excluded.seen_at
  `)
  const selectId = db.prepare('SELECT id FROM skills WHERE path = ?')
  const insertFts = db.prepare('INSERT INTO skills_fts (rowid, name, description, tags, body) VALUES (?, ?, ?, ?, ?)')

  db.exec('BEGIN')
  try {
    for (const row of roots) {
      upsertRoot.run(
        row.path,
        row.scope,
        JSON.stringify(row.owners),
        row.exists ? 1 : 0,
        row.count,
        row.truncated ? 1 : 0,
        at,
        row.error ?? null
      )
    }

    const idByPath = new Map<string, number>()
    for (const skill of skills) {
      upsertSkill.run(
        skill.path,
        skill.name,
        skill.description,
        skill.rootPath,
        skill.scope,
        skill.bodyChars,
        skill.tokens,
        JSON.stringify(skill.tags),
        skill.packageHash,
        skill.mtime,
        skill.files,
        skill.bytes,
        JSON.stringify(skill.health),
        at
      )
      const row = selectId.get(skill.path) as { id: number } | undefined
      if (row) idByPath.set(skill.path, row.id)
    }

    // Anything not seen in this pass is gone from disk or unreadable.
    db.prepare('DELETE FROM skills WHERE seen_at <> ?').run(at)

    db.exec('DELETE FROM skills_fts;')
    for (const skill of skills) {
      const id = idByPath.get(skill.path)
      if (!id) continue
      insertFts.run(id, skill.name, skill.description, skill.tags.join(' '), skill.text)
    }

    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'last_scan_at',
      at
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return at
}

function buildMatch(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((term) => term.replace(/["'*:^()-]/g, '').trim())
    .filter(Boolean)
    .slice(0, 8)
  if (terms.length === 0) return ''
  return terms.map((term) => `"${term}"*`).join(' AND ')
}

export function querySkills(query: SkillQuery): { total: number; rows: SkillRow[] } {
  const db = getDb()
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 500)
  const offset = Math.max(query.offset ?? 0, 0)

  const match = query.q ? buildMatch(query.q) : ''
  const filters: string[] = []
  const params: (string | number)[] = []

  if (match) {
    filters.push('skills_fts MATCH ?')
    params.push(match)
  }
  if (query.root) {
    filters.push('s.root_path = ?')
    params.push(query.root)
  }
  if (query.tag) {
    filters.push('s.tags LIKE ?')
    params.push(`%"${query.tag}"%`)
  }
  if (query.health) {
    filters.push("s.health <> '[]'")
  }

  if (match) {
    const from = 'FROM skills s JOIN skills_fts ON skills_fts.rowid = s.id'
    const where = `WHERE ${filters.join(' AND ')}`
    const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${where}`).get(...params) as { n: number }
    const rows = db
      .prepare(`SELECT s.* ${from} ${where} ORDER BY bm25(skills_fts) LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as SkillRow[]
    return { total: total?.n ?? 0, rows }
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM skills s ${where}`).get(...params) as { n: number }
  const rows = db
    .prepare(`SELECT s.* FROM skills s ${where} ORDER BY s.name COLLATE NOCASE LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as SkillRow[]
  return { total: total?.n ?? 0, rows }
}

export function getSkill(id: number): SkillRow | undefined {
  return getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as unknown as SkillRow | undefined
}

export function readRoots(): RootRow[] {
  return getDb().prepare('SELECT * FROM roots ORDER BY path').all() as unknown as RootRow[]
}

export function readMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
  return row?.value ?? null
}

export function totals(): { skills: number; tokens: number; issues: number; roots: number } {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS skills, COALESCE(SUM(tokens),0) AS tokens,
                     SUM(CASE WHEN health <> '[]' THEN 1 ELSE 0 END) AS issues,
                     COUNT(DISTINCT root_path) AS roots
              FROM skills`)
    .get() as { skills: number; tokens: number; issues: number; roots: number }
  return { skills: row.skills, tokens: row.tokens, issues: row.issues ?? 0, roots: row.roots }
}

export function tagFacets(): { tag: string; count: number }[] {
  const rows = getDb().prepare('SELECT tags FROM skills').all() as { tags: string }[]
  const counts = new Map<string, number>()
  for (const row of rows) {
    let tags: string[] = []
    try {
      tags = JSON.parse(row.tags)
    } catch {
      continue
    }
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 24)
}
