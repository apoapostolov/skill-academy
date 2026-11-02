import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './config'
import type { RootEntry, RootScan, ScanOutcome } from './scan'
import type { SkillRecord } from './skill'

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

export interface SaveResult {
  added: number
  changed: number
  removed: number
}

const SCHEMA_VERSION = 10

let database: DatabaseSync | undefined

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value?: string }
    | undefined
  if (Number(stored?.value ?? 0) !== SCHEMA_VERSION) {
    // Derived data only. A column change cannot be patched onto an existing table with
    // CREATE TABLE IF NOT EXISTS, so the shape change drops and rebuilds instead.
    db.exec(`
      DROP TABLE IF EXISTS skills_fts;
      DROP TABLE IF EXISTS skill_body;
      DROP TABLE IF EXISTS placements;
      DROP TABLE IF EXISTS skills;
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS roots (
      path TEXT PRIMARY KEY, scope TEXT NOT NULL, owners TEXT NOT NULL,
      present INTEGER NOT NULL, skill_count INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      real_path TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL,
      scope TEXT NOT NULL,
      body_chars INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      package_hash TEXT NOT NULL DEFAULT '',
      mtime TEXT NOT NULL DEFAULT '',
      files INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      health TEXT NOT NULL DEFAULT '[]',
      seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skills_root ON skills(root_path);
    CREATE INDEX IF NOT EXISTS skills_name ON skills(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS skills_real ON skills(real_path);
    CREATE TABLE IF NOT EXISTS placements (
      skill_id    INTEGER NOT NULL,
      root_path   TEXT NOT NULL,
      target_path TEXT NOT NULL,
      mode        TEXT NOT NULL,
      seen_at     TEXT NOT NULL,
      PRIMARY KEY (skill_id, root_path)
    );
    CREATE INDEX IF NOT EXISTS placements_root ON placements(root_path);
    CREATE TABLE IF NOT EXISTS skill_body (
      skill_id INTEGER PRIMARY KEY,
      body     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_prefs (
      agent      TEXT PRIMARY KEY,
      hidden     INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal (
      id         INTEGER PRIMARY KEY,
      at         TEXT NOT NULL,
      action     TEXT NOT NULL,
      payload    TEXT NOT NULL,
      undone_at  TEXT
    );
  `)

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

function rebuildFts(db: DatabaseSync): void {
  // A contentless FTS5 table has no row storage to delete from; `delete-all` is the
  // only supported way to clear it before a rebuild.
  db.exec("INSERT INTO skills_fts(skills_fts) VALUES('delete-all')")
  db.exec(`
    INSERT INTO skills_fts (rowid, name, description, tags, body)
    SELECT s.id, s.name, s.description, s.tags, COALESCE(b.body, '')
    FROM skills s LEFT JOIN skill_body b ON b.skill_id = s.id
  `)
}

/**
 * Writes only what changed. A rescan of an unchanged root touches nothing, which is
 * what makes a five-minute safety sweep affordable and what the P1 exit asks for.
 */
export function saveRoot(entry: RootEntry, text?: Map<string, string>): SaveResult {
  const db = getDb()
  const at = new Date().toISOString()
  const result: SaveResult = { added: 0, changed: 0, removed: 0 }

  const rootRow = db.prepare('SELECT * FROM roots WHERE path = ?').get(entry.root.path) as RootRow | undefined
  const nextCount = entry.root.count
  const nextPresent = entry.root.exists ? 1 : 0
  const nextTruncated = entry.root.truncated ? 1 : 0
  const nextError = entry.root.error ?? null
  if (
    !rootRow ||
    rootRow.skill_count !== nextCount ||
    rootRow.present !== nextPresent ||
    rootRow.truncated !== nextTruncated ||
    rootRow.error !== nextError
  ) {
    db.prepare(`
      INSERT INTO roots (path, scope, owners, present, skill_count, truncated, last_scan_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        scope = excluded.scope, owners = excluded.owners, present = excluded.present,
        skill_count = excluded.skill_count, truncated = excluded.truncated,
        last_scan_at = excluded.last_scan_at, error = excluded.error
    `).run(
      entry.root.path,
      entry.root.scope,
      JSON.stringify(entry.root.owners),
      nextPresent,
      nextCount,
      nextTruncated,
      at,
      nextError
    )
  }

  const existing = db.prepare('SELECT id, package_hash FROM skills WHERE real_path = ?')
  const insert = db.prepare(`
    INSERT INTO skills (path, real_path, name, description, root_path, scope, body_chars, tokens, tags,
                        package_hash, mtime, files, bytes, health, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const update = db.prepare(`
    UPDATE skills SET path = ?, name = ?, description = ?, root_path = ?, scope = ?, body_chars = ?, tokens = ?,
      tags = ?, package_hash = ?, mtime = ?, files = ?, bytes = ?, health = ?, seen_at = ?
    WHERE id = ?
  `)
  const upsertBody = db.prepare(
    'INSERT INTO skill_body (skill_id, body) VALUES (?, ?) ON CONFLICT(skill_id) DO UPDATE SET body = excluded.body'
  )

  const idsByReal = new Map<string, number>()
  for (const skill of entry.skills) {
    const real = skill.realPath ?? skill.path
    const row = existing.get(real) as { id: number; package_hash: string } | undefined
    if (!row) {
      insert.run(
        skill.path,
        real,
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
      const created = db.prepare('SELECT id FROM skills WHERE real_path = ?').get(real) as { id: number } | undefined
      if (created) {
        idsByReal.set(real, created.id)
        upsertBody.run(created.id, skill.text)
      }
      result.added += 1
      continue
    }
    idsByReal.set(real, row.id)
    if (row.package_hash === skill.packageHash) continue
    update.run(
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
      at,
      row.id
    )
    upsertBody.run(row.id, skill.text)
    result.changed += 1
  }

  // Placements are what the scan just observed for this root; replace them wholesale.
  db.prepare('DELETE FROM placements WHERE root_path = ?').run(entry.root.path)
  const insertPlacement = db.prepare(`
    INSERT INTO placements (skill_id, root_path, target_path, mode, seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(skill_id, root_path) DO UPDATE SET
      target_path = excluded.target_path, mode = excluded.mode, seen_at = excluded.seen_at
  `)
  const placed = new Set<string>()
  for (const placement of entry.placements) {
    const id = idsByReal.get(placement.realPath)
    if (!id) continue
    insertPlacement.run(id, entry.root.path, placement.targetPath, placement.mode, at)
    placed.add(placement.realPath)
  }

  // A skill survives as long as any root can still see it, whatever path it is seen at.
  const stale = db
    .prepare('SELECT id FROM skills WHERE id NOT IN (SELECT skill_id FROM placements)')
    .all() as { id: number }[]
  if (stale.length > 0) {
    const remove = db.prepare('DELETE FROM skills WHERE id = ?')
    const removeBody = db.prepare('DELETE FROM skill_body WHERE skill_id = ?')
    for (const row of stale) {
      removeBody.run(row.id)
      remove.run(row.id)
    }
    result.removed = stale.length
  }

  return result
}

/** Rebuild the search index once, after a batch of writes rather than per package. */
export function rebuildIndex(): void {
  rebuildFts(getDb())
}

export function saveScan(outcome: ScanOutcome): SaveResult {
  const db = getDb()
  const total: SaveResult = { added: 0, changed: 0, removed: 0 }
  db.exec('BEGIN')
  try {
    for (const entry of outcome.entries) {
      const result = saveRoot(entry)
      total.added += result.added
      total.changed += result.changed
      total.removed += result.removed
    }
    if (total.added + total.changed + total.removed > 0) rebuildFts(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return total
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
    filters.push('(s.root_path = ? OR s.id IN (SELECT skill_id FROM placements WHERE root_path = ?))')
    params.push(query.root, query.root)
  }
  if (query.tag) {
    filters.push('s.tags LIKE ?')
    params.push(`%"${query.tag}"%`)
  }
  if (query.health) filters.push("s.health <> '[]'")

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

/** One package, written only if its hash moved. Used by the watcher for sub-second updates. */
export function saveOne(rootPath: string, scope: string, skill: SkillRecord): SaveResult {
  const db = getDb()
  const at = new Date().toISOString()
  const result: SaveResult = { added: 0, changed: 0, removed: 0 }
  const real = skill.realPath ?? skill.path
  const row = db.prepare('SELECT id, package_hash FROM skills WHERE real_path = ?').get(real) as
    | { id: number; package_hash: string }
    | undefined

  if (!row) {
    db.prepare(`
      INSERT INTO skills (path, real_path, name, description, root_path, scope, body_chars, tokens, tags,
                          package_hash, mtime, files, bytes, health, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skill.path,
      real,
      skill.name,
      skill.description,
      rootPath,
      scope,
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
    const created = db.prepare('SELECT id FROM skills WHERE real_path = ?').get(real) as { id: number } | undefined
    if (created) {
      db.prepare(
        'INSERT INTO skill_body (skill_id, body) VALUES (?, ?) ON CONFLICT(skill_id) DO UPDATE SET body = excluded.body'
      ).run(created.id, skill.text)
    }
    result.added = 1
  } else if (row.package_hash !== skill.packageHash) {
    db.prepare(`
      UPDATE skills SET name = ?, description = ?, root_path = ?, scope = ?, body_chars = ?, tokens = ?,
        tags = ?, package_hash = ?, mtime = ?, files = ?, bytes = ?, health = ?, seen_at = ?
      WHERE path = ?
    `).run(
      skill.name,
      skill.description,
      rootPath,
      scope,
      skill.bodyChars,
      skill.tokens,
      JSON.stringify(skill.tags),
      skill.packageHash,
      skill.mtime,
      skill.files,
      skill.bytes,
      JSON.stringify(skill.health),
      at,
      skill.path
    )
    db.prepare(
      'INSERT INTO skill_body (skill_id, body) VALUES (?, ?) ON CONFLICT(skill_id) DO UPDATE SET body = excluded.body'
    ).run(row.id, skill.text)
    result.changed = 1
  }

  if (result.added + result.changed > 0) rebuildFts(db)
  return result
}

export function removeByPath(skillPath: string): number {
  const db = getDb()
  const row = db.prepare('SELECT id FROM skills WHERE path = ?').get(skillPath) as { id: number } | undefined
  if (!row) return 0
  db.prepare('DELETE FROM skill_body WHERE skill_id = ?').run(row.id)
  db.prepare('DELETE FROM skills WHERE id = ?').run(row.id)
  rebuildFts(db)
  return 1
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

export function tokensByRoot(): Record<string, { tokens: number; count: number }> {
  const rows = getDb()
    .prepare(`
      SELECT p.root_path AS root_path, SUM(s.tokens) AS tokens, COUNT(*) AS count
      FROM placements p JOIN skills s ON s.id = p.skill_id
      GROUP BY p.root_path
    `)
    .all() as { root_path: string; tokens: number; count: number }[]
  const out: Record<string, { tokens: number; count: number }> = {}
  for (const row of rows) out[row.root_path] = { tokens: row.tokens, count: row.count }
  return out
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

export function countsByRoot(): Record<string, number> {
  const rows = getDb().prepare('SELECT root_path, COUNT(*) AS n FROM skills GROUP BY root_path').all() as {
    root_path: string
    n: number
  }[]
  const out: Record<string, number> = {}
  for (const row of rows) out[row.root_path] = row.n
  return out
}

/** Agents the user has taken out of the sidebar. Display only: nothing is unmounted or disabled. */
export function listHiddenAgents(): string[] {
  const rows = getDb().prepare('SELECT agent FROM agent_prefs WHERE hidden = 1').all() as { agent: string }[]
  return rows.map((row) => row.agent)
}

export function setAgentHidden(agent: string, hidden: boolean): void {
  getDb()
    .prepare(`
      INSERT INTO agent_prefs (agent, hidden, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET hidden = excluded.hidden, updated_at = excluded.updated_at
    `)
    .run(agent, hidden ? 1 : 0, new Date().toISOString())
}

export interface JournalRow {
  id: number
  at: string
  action: string
  payload: string
  undone_at: string | null
}

export function addJournal(action: string, payload: unknown): number {
  const result = getDb()
    .prepare('INSERT INTO journal (at, action, payload) VALUES (?, ?, ?)')
    .run(new Date().toISOString(), action, JSON.stringify(payload))
  return Number(result.lastInsertRowid)
}

export function setAllAgentVisibility(agents: string[], hidden: boolean): void {
  const db = getDb()
  const at = new Date().toISOString()
  const statement = db.prepare(`
    INSERT INTO agent_prefs (agent, hidden, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(agent) DO UPDATE SET hidden = excluded.hidden, updated_at = excluded.updated_at
  `)
  db.exec('BEGIN')
  try {
    for (const agent of agents) statement.run(agent, hidden ? 1 : 0, at)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function recentJournal(limit = 50): JournalRow[] {
  return getDb().prepare('SELECT * FROM journal ORDER BY id DESC LIMIT ?').all(limit) as unknown as JournalRow[]
}

export interface SkillPlacement {
  rootPath: string
  targetPath: string
  mode: string
}

/** Every root that can see this skill, with the path it sees and how it got there. */
export function listPlacements(skillId: number): SkillPlacement[] {
  return getDb()
    .prepare(`
      SELECT root_path AS rootPath, target_path AS targetPath, mode
      FROM placements WHERE skill_id = ? ORDER BY root_path
    `)
    .all(skillId) as unknown as SkillPlacement[]
}

export type { RootScan }
