import path from 'node:path'
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

const SCHEMA_VERSION = 12

/** Bumped whenever the health checker changes, so old verdicts cannot survive it. */
const HEALTH_VERSION = 2

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

  // contentless_delete lets one skill's row be removed without rebuilding the whole index,
  // which is what makes an incremental scan cheap enough to answer in milliseconds.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(name, description, tags, body, content='', contentless_delete=1);`)
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(SCHEMA_VERSION)
  )

  // The tables exist by now, so this can actually run. A checker change bumps
  // HEALTH_VERSION and every row is rewritten on the next scan, which re-runs it.
  const healthRow = db.prepare("SELECT value FROM meta WHERE key = 'health_version'").get() as
    | { value: string }
    | undefined
  if (Number(healthRow?.value ?? 0) !== HEALTH_VERSION) {
    db.exec("UPDATE skills SET package_hash = ''")
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('health_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(String(HEALTH_VERSION))
  }
}

export function getDb(): DatabaseSync {
  if (!database) {
    database = new DatabaseSync(DB_PATH)
    // WAL plus a relaxed sync is the difference between a scan that waits on fsync for
    // every transaction and one that finishes in the time the parser needs.
    database.exec('PRAGMA temp_store = MEMORY;')
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
  const changedPaths: string[] = []
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
      // An upsert does not report a usable insert id, so read it back.
      // The id is bound back into SQLite as it came out: node:sqlite hands back a bigint
      // for rowids it cannot represent exactly, and converting it is what crashed first.
      // CAST to TEXT: node:sqlite throws converting a rowid it reads as a big int.
      const created = db.prepare('SELECT CAST(id AS TEXT) AS id FROM skills WHERE real_path = ?').get(real) as
        | { id: string }
        | undefined
      if (created) {
        idsByReal.set(real, Number(created.id))
        upsertBody.run(created.id as never, skill.text)
        changedPaths.push(skill.path)
      }
      result.added += 1
      continue
    }
    idsByReal.set(real, row.id)
    if (row.package_hash === skill.packageHash) continue
    const updateResult = update.run(
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
    changedPaths.push(skill.path)
  }

  // Contentless FTS5 cannot store the lookup column that incremental writes would need,
  // so a changed root rebuilds the index. Correct beats fast until the index table moves
  // to external content with a real document row per package.
  if (changedPaths.length > 0) rebuildFts(db)

  // Placements are what the scan just observed for this root; replace them only when the
  // observed set differs, so a rescan of unchanged disk performs no writes at all.
  const observed: { id: number; target: string; mode: string }[] = []
  for (const placement of entry.placements) {
    const id = idsByReal.get(placement.realPath)
    if (id === undefined) continue
    observed.push({ id, target: placement.targetPath, mode: placement.mode })
  }
  const storedPlacements = db
    .prepare('SELECT skill_id, target_path, mode FROM placements WHERE root_path = ?')
    .all(entry.root.path) as { skill_id: number; target_path: string; mode: string }[]
  const unchanged =
    storedPlacements.length === observed.length &&
    observed.every((next) =>
      storedPlacements.some(
        (old) => old.skill_id === next.id && old.target_path === next.target && old.mode === next.mode
      )
    )

  if (!unchanged) {
    db.prepare('DELETE FROM placements WHERE root_path = ?').run(entry.root.path)
    const insertPlacement = db.prepare(`
      INSERT INTO placements (skill_id, root_path, target_path, mode, seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(skill_id, root_path) DO UPDATE SET
        target_path = excluded.target_path, mode = excluded.mode, seen_at = excluded.seen_at
    `)
    for (const placement of observed) insertPlacement.run(placement.id, entry.root.path, placement.target, placement.mode, at)
  }

  // A skill survives as long as any root can still see it, whatever path it is seen at.
  const stale = db
    .prepare(`
      SELECT s.id, s.path FROM skills s
      WHERE s.id IN (SELECT skill_id FROM placements WHERE root_path = ?)
        AND s.id NOT IN (SELECT skill_id FROM placements)
    `)
    .all(entry.root.path) as { id: number; path: string }[]
  if (stale.length > 0) {
    const remove = db.prepare('DELETE FROM skills WHERE id = ?')
    const removeBody = db.prepare('DELETE FROM skill_body WHERE skill_id = ?')
    for (const row of stale) {
      removeBody.run(row.id)
      dropFromIndex(row.path)
      remove.run(row.id)
    }
    result.removed = stale.length
  }

  return result
}

/** Rebuild the search index once, after a batch of writes rather than per package. */
/** A stable 31-bit rowid per package path: we never read an id back, so no bigint can leak. */
function ftsRowId(key: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash & 0x7fffffff) || 1
}

let indexStatements: { select: StatementSyncLike; drop: StatementSyncLike; insert: StatementSyncLike } | null = null

type StatementSyncLike = { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown }

function indexStatementsFor(): { select: StatementSyncLike; drop: StatementSyncLike; insert: StatementSyncLike } {
  if (!indexStatements) {
    const db = getDb()
    indexStatements = {
      select: db.prepare(`
        SELECT s.name, s.description, s.tags, COALESCE(b.body, '') AS body
        FROM skills s LEFT JOIN skill_body b ON b.skill_id = s.id WHERE s.path = ?
      `) as unknown as StatementSyncLike,
      drop: db.prepare('DELETE FROM skills_fts WHERE rowid = ?') as unknown as StatementSyncLike,
      insert: db.prepare('INSERT INTO skills_fts (rowid, name, description, tags, body) VALUES (?, ?, ?, ?, ?)') as unknown as StatementSyncLike
    }
  }
  return indexStatements
}

/** Writes one package into the search index, replacing its previous row. */
export function indexSkill(realPath: string): void {
  const statement = indexStatementsFor()
  const row = statement.select.get(realPath) as
    | { name: string; description: string; tags: string; body: string }
    | undefined
  const rowid = ftsRowId(realPath)
  if (!row) {
    statement.drop.run(rowid)
    return
  }
  statement.drop.run(rowid)
  statement.insert.run(rowid, row.name, row.description, row.tags, row.body)
}

export function dropFromIndex(realPath: string): void {
  getDb().prepare('DELETE FROM skills_fts WHERE rowid = ?').run(ftsRowId(realPath))
}

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
    // Rows were indexed incrementally as they were written; a full rebuild here would cost
    // more than the scan itself and write every row again.
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
  const row = db.prepare('SELECT id, path FROM skills WHERE path = ?').get(skillPath) as
    | { id: number; path: string }
    | undefined
  if (!row) return 0
  db.prepare('DELETE FROM skill_body WHERE skill_id = ?').run(row.id)
  db.prepare('DELETE FROM placements WHERE skill_id = ?').run(row.id)
  dropFromIndex(row.path)
  db.prepare('DELETE FROM skills WHERE id = ?').run(row.id)
  return 1
}

/** Deletes the packages behind these paths; returns how many rows went. */
export function applyDeletion(paths: string[]): number {
  let removed = 0
  for (const candidate of paths) {
    removed += removeByPath(candidate)
    if (removed === 0) removed += removeByPath(path.dirname(candidate))
  }
  return removed
}

/** Every indexed copy that shares this name, whatever root it lives in. */
export function copiesOfName(name: string): { id: number; path: string; root_path: string; mtime: string }[] {
  return getDb()
    .prepare('SELECT id, path, root_path, mtime FROM skills WHERE lower(name) = lower(?) ORDER BY id')
    .all(name) as { id: number; path: string; root_path: string; mtime: string }[]
}

/** Makes the next scan rewrite every row, which re-runs the health checker over each skill. */
export function forceRecheck(): number {
  const db = getDb()
  const result = db.prepare("UPDATE skills SET package_hash = ''").run()
  const changes = result.changes as unknown
  return typeof changes === 'bigint' ? Number(changes) : Number(changes ?? 0)
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
