import { existsSync } from 'node:fs'
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
  category: string
  risk: string
  findings: string
  package_hash: string
  mtime: string
  files: number
  bytes: number
  health: string
}

export interface SkillQuery {
  q?: string
  status?: 'active' | 'archived' | 'all' 
  root?: string
  tag?: string
  category?: string
  health?: boolean
  limit?: number
  offset?: number
}

export interface SaveResult {
  added: number
  changed: number
  removed: number
}

const SCHEMA_VERSION = 15

/** Bumped whenever the health checker changes, so old verdicts cannot survive it. */
const HEALTH_VERSION = 3

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
      DROP TABLE IF EXISTS skills_doc;
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
      category TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT 'clean',
      findings TEXT NOT NULL DEFAULT '[]',
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
    -- Trash is user data, not derived: it survives every schema change.
    CREATE TABLE IF NOT EXISTS trash (
      id          INTEGER PRIMARY KEY,
      skill_path  TEXT NOT NULL,
      name        TEXT NOT NULL,
      root_path   TEXT NOT NULL,
      scope       TEXT NOT NULL,
      moved_to    TEXT NOT NULL,
      at          TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      restored_at TEXT
    );
    CREATE TABLE IF NOT EXISTS journal (
      id         INTEGER PRIMARY KEY,
      at         TEXT NOT NULL,
      action     TEXT NOT NULL,
      payload    TEXT NOT NULL,
      undone_at  TEXT
    );
  `)

  // External content: the document row carries the path, so one package can be reindexed
  // or dropped without touching the rest, and a rowid always maps back to a real skill.
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills_doc (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      body TEXT NOT NULL DEFAULT ''
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
      name, description, tags, body, content='skills_doc', content_rowid='id'
    );
  `)
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
    database.exec('PRAGMA journal_mode = WAL;')
    database.exec('PRAGMA synchronous = NORMAL;')
    migrate(database)
  }
  return database
}

function rebuildFts(db: DatabaseSync): void {
  // Repopulate the document table, then let FTS5 rebuild itself from it.
  db.exec(`
    DELETE FROM skills_doc;
    INSERT INTO skills_doc (path, name, description, tags, body)
    SELECT s.path, s.name, s.description, s.tags, COALESCE(b.body, '')
    FROM skills s LEFT JOIN skill_body b ON b.skill_id = s.id;
    INSERT INTO skills_fts(skills_fts) VALUES('rebuild');
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

  const existing = db.prepare('SELECT id, package_hash FROM skills WHERE real_path = ? OR path = ?')
  const insert = db.prepare(`
    INSERT INTO skills (path, real_path, name, description, root_path, scope, body_chars, tokens, tags,
                        category, risk, findings, package_hash, mtime, files, bytes, health, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET real_path = excluded.real_path, name = excluded.name,
      description = excluded.description, root_path = excluded.root_path, scope = excluded.scope,
      body_chars = excluded.body_chars, tokens = excluded.tokens, tags = excluded.tags,
      category = excluded.category, risk = excluded.risk, findings = excluded.findings,
      package_hash = excluded.package_hash, mtime = excluded.mtime, files = excluded.files,
      bytes = excluded.bytes, health = excluded.health, seen_at = excluded.seen_at
  `)
  const update = db.prepare(`
    UPDATE skills SET name = ?, description = ?, root_path = ?, scope = ?, body_chars = ?, tokens = ?,
      tags = ?, category = ?, risk = ?, findings = ?, package_hash = ?, mtime = ?, files = ?, bytes = ?, health = ?,
      seen_at = ?
    WHERE id = ?
  `)
  const upsertBody = db.prepare(
    'INSERT INTO skill_body (skill_id, body) VALUES (?, ?) ON CONFLICT(skill_id) DO UPDATE SET body = excluded.body'
  )

  const idsByReal = new Map<string, number>()
  // Prepared once: preparing inside the loop was most of the cost of indexing two thousand rows.
  const createdOf = db.prepare('SELECT CAST(id AS TEXT) AS id FROM skills WHERE real_path = ?')
  const dropDuplicate = db.prepare('DELETE FROM skills WHERE path = ? AND id <> ?')
  const changedSkills: Array<{ path: string; name: string; description: string; tags: string; text: string }> = []
  for (const skill of entry.skills) {
    const real = skill.realPath ?? skill.path
    const row = existing.get(real, skill.path) as { id: number; package_hash: string } | undefined
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
        skill.category,
        skill.risk,
        JSON.stringify(skill.findings),
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
      const created = createdOf.get(real) as { id: string } | undefined
      if (created) {
        idsByReal.set(real, Number(created.id))
        upsertBody.run(created.id as never, skill.text)
        changedSkills.push({
          path: skill.path,
          name: skill.name,
          description: skill.description,
          tags: JSON.stringify(skill.tags),
          text: skill.text
        })
      }
      result.added += 1
      continue
    }
    idsByReal.set(real, row.id)
    // Another row could hold this path from an earlier placement round; the real path is
    // the identity, so the duplicate goes before anything else touches the table.
    dropDuplicate.run(skill.path, row.id)
    if (row.package_hash === skill.packageHash) continue
    const updateResult = update.run(
      skill.name,
      skill.description,
      skill.rootPath,
      skill.scope,
      skill.bodyChars,
      skill.tokens,
      JSON.stringify(skill.tags),
      skill.category,
      skill.risk,
      JSON.stringify(skill.findings),
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
    changedSkills.push({
      path: skill.path,
      name: skill.name,
      description: skill.description,
      tags: JSON.stringify(skill.tags),
      text: skill.text
    })
  }

  // Only what actually changed is reindexed: the document row carries the path, so one
  // package is touched instead of the whole table.
  if (changedSkills.length > 0) {
    db.exec('SAVEPOINT index_changes')
    try {
      // The row we just wrote is the row to index: reading it back was a query per skill.
      for (const changed of changedSkills) {
        indexedFor({ name: changed.name, description: changed.description, tags: changed.tags, body: changed.text }, changed.path)
      }
      db.exec('RELEASE index_changes')
    } catch (error) {
      db.exec('ROLLBACK TO index_changes')
      throw error
    }
  }

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

  // A skill whose directory is gone is not a skill, even when it was never placed in an
  // agent folder. The parent check keeps an unplugged drive from emptying the library.
  const vanished = (db.prepare('SELECT id, path FROM skills').all() as { id: number; path: string }[]).filter(
    (row) => !existsSync(row.path) && existsSync(path.dirname(path.dirname(row.path)))
  )
  if (vanished.length > 0) {
    const remove = db.prepare('DELETE FROM skills WHERE id = ?')
    const removeBody = db.prepare('DELETE FROM skill_body WHERE skill_id = ?')
    for (const row of vanished) {
      removeBody.run(row.id)
      dropFromIndex(row.path)
      remove.run(row.id)
    }
    result.removed += vanished.length
  }

  return result
}

/** Rebuild the search index from scratch; used after a full scan. */
/** Statements are prepared once per connection: a scan indexes two thousand rows in a loop. */
const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()

function stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
  const cached = statements.get(sql)
  if (cached) return cached
  const prepared = getDb().prepare(sql)
  statements.set(sql, prepared)
  return prepared
}

function indexedFor(row: { name: string; description: string; tags: string; body: string }, path: string): { rowid: number } | null {
  const existing = stmt('SELECT id, name, description, tags, body FROM skills_doc WHERE path = ?').get(path) as
    | { id: number; name: string; description: string; tags: string; body: string }
    | undefined
  if (existing) {
    // FTS5 removes a row only when it is handed the exact values that were indexed. Reading them
    // back from another table (skill_body) corrupts the index instead: the next query reports a
    // malformed database.
    stmt(`INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, body) VALUES('delete', ?, ?, ?, ?, ?)`).run(
      existing.id,
      existing.name,
      existing.description,
      existing.tags,
      existing.body
    )
  }
  const stored = stmt(`
      INSERT INTO skills_doc (path, name, description, tags, body) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET name = excluded.name, description = excluded.description,
        tags = excluded.tags, body = excluded.body
      RETURNING id
    `).get(path, row.name, row.description, row.tags, row.body) as { id: number } | undefined
  if (!stored) return null
  stmt('INSERT INTO skills_fts (rowid, name, description, tags, body) VALUES (?, ?, ?, ?, ?)').run(
    stored.id,
    row.name,
    row.description,
    row.tags,
    row.body
  )
  return { rowid: stored.id }
}

/** The indexed text for one package path, straight from the live tables. */
function docValues(path: string): [string, string, string, string] {
  const found = getDb()
    .prepare(`
      SELECT s.name, s.description, s.tags, COALESCE(b.body, '') AS body
      FROM skills s LEFT JOIN skill_body b ON b.skill_id = s.id WHERE s.path = ?
    `)
    .get(path) as { name: string; description: string; tags: string; body: string } | undefined
  return found ? [found.name, found.description, found.tags, found.body] : ['', '', '[]', '']
}

/** Writes one package into the search index, replacing its previous row. */
export function indexSkill(path: string): void {
  const values = docValues(path)
  indexedFor({ name: values[0], description: values[1], tags: values[2], body: values[3] }, path)
}

/**
 * Removes one package from the search index.
 *
 * FTS5 only removes a row when it is handed the values it indexed, so they are read back from
 * `skills_doc`, the table the insert came from. Reading them from `skill_body` (via `docValues`)
 * leaves the row behind and, worse, corrupts the index.
 */
export function dropFromIndex(path: string): void {
  const db = getDb()
  const existing = db
    .prepare('SELECT id, name, description, tags, body FROM skills_doc WHERE path = ?')
    .get(path) as { id: number; name: string; description: string; tags: string; body: string } | undefined
  if (existing) {
    db.prepare(`INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, body) VALUES('delete', ?, ?, ?, ?, ?)`)
      .run(existing.id, existing.name, existing.description, existing.tags, existing.body)
  }
  db.prepare('DELETE FROM skills_doc WHERE path = ?').run(path)
}

/**
 * Search documents whose skill no longer exists. A removal that missed its document leaves a row
 * that no search can reach (every query joins `skills`) but every later insert for the same path
 * can collide with. Swept after a scan, when the set of packages is known.
 */
export function dropOrphanDocs(): number {
  const db = getDb()
  const orphans = db
    .prepare('SELECT d.id, d.path, d.name, d.description, d.tags, d.body FROM skills_doc d LEFT JOIN skills s ON s.path = d.path WHERE s.id IS NULL')
    .all() as Array<{ id: number; path: string; name: string; description: string; tags: string; body: string }>
  for (const row of orphans) {
    db.prepare(`INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, body) VALUES('delete', ?, ?, ?, ?, ?)`)
      .run(row.id, row.name, row.description, row.tags, row.body)
    db.prepare('DELETE FROM skills_doc WHERE id = ?').run(row.id)
  }
  return orphans.length
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

/**
 * A skill under `<root>/.archive/` belongs to that platform's archive. Derived from the path,
 * so an existing index needs no migration and a moved folder changes category on the next scan.
 */
// Qualified, because a search joins skills_doc, which has a path column of its own.
export const ARCHIVED_SQL = "s.path LIKE '%/.archive/%' OR s.path LIKE '%\\.archive\\%'"

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
  if (query.category) {
    filters.push('s.category = ?')
    params.push(query.category)
  }
  if (query.health) filters.push("s.health <> '[]'")
  // Off means moved into the platform's own .archive folder, so status is read from the path.
  if (query.status === 'archived') filters.push(ARCHIVED_SQL)
  if (query.status === 'active') filters.push('NOT (' + ARCHIVED_SQL + ')')

  if (match) {
    const from =
    'FROM skills s JOIN skills_doc d ON d.path = s.path JOIN skills_fts ON skills_fts.rowid = d.id'
    const where = `WHERE ${filters.join(' AND ')}`
    const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${where}`).get(...params) as { n: number }
    if ((total?.n ?? 0) === 0) {
      // Full-text search splits on hyphens, so `zz-revert` matches neither token alone. A name or
      // path substring is what a person typing a skill's name means, so it answers when FTS cannot.
      // The MATCH filter belongs to the full-text join and cannot ride along into a plain query.
      const plain = filters.filter((filter) => filter !== 'skills_fts MATCH ?')
      const plainParams = params.slice(1)
      const needle = `%${query.q ?? ''}%`
      const loose = [...plain, '(s.name LIKE ? OR s.path LIKE ?)']
      const looseParams = [...plainParams, needle, needle]
      const looseWhere = `WHERE ${loose.join(' AND ')}`
      const looseTotal = db
        .prepare(`SELECT COUNT(*) AS n FROM skills s ${looseWhere}`)
        .get(...looseParams) as { n: number }
      const looseRows = db
        .prepare(`SELECT s.* FROM skills s ${looseWhere} ORDER BY s.name COLLATE NOCASE LIMIT ? OFFSET ?`)
        .all(...looseParams, limit, offset) as unknown as SkillRow[]
      return { total: looseTotal?.n ?? 0, rows: looseRows }
    }
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
  const row = db
    .prepare('SELECT id, package_hash FROM skills WHERE real_path = ? OR path = ?')
    .get(real, skill.path) as { id: number; package_hash: string } | undefined

  db.prepare('DELETE FROM skills WHERE path = ? AND id <> ?').run(skill.path, row?.id ?? -1)

  if (!row) {
    db.prepare(`
      INSERT INTO skills (path, real_path, name, description, root_path, scope, body_chars, tokens, tags,
                          category, risk, findings, package_hash, mtime, files, bytes, health, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET real_path = excluded.real_path, name = excluded.name,
        description = excluded.description, root_path = excluded.root_path, scope = excluded.scope,
        body_chars = excluded.body_chars, tokens = excluded.tokens, tags = excluded.tags,
        category = excluded.category, risk = excluded.risk, findings = excluded.findings,
        package_hash = excluded.package_hash, mtime = excluded.mtime, files = excluded.files,
        bytes = excluded.bytes, health = excluded.health, seen_at = excluded.seen_at
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
      skill.category,
      skill.risk,
      JSON.stringify(skill.findings),
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
        tags = ?, category = ?, risk = ?, findings = ?, package_hash = ?, mtime = ?, files = ?, bytes = ?,
        health = ?, seen_at = ?
      WHERE path = ?
    `).run(
      skill.name,
      skill.description,
      rootPath,
      scope,
      skill.bodyChars,
      skill.tokens,
      JSON.stringify(skill.tags),
      skill.category,
      skill.risk,
      JSON.stringify(skill.findings),
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

  if (result.added + result.changed > 0) indexSkill(skill.path)
  return result
}

/** Every indexed package, for the scan's vanishing check. */
export function allSkillPaths(): { id: number; path: string }[] {
  return getDb().prepare('SELECT id, path FROM skills').all() as { id: number; path: string }[]
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
}

/** Categories are the authors' own grouping, counted separately from tags. */
export function categoryFacets(): { category: string; count: number }[] {
  return getDb()
    .prepare("SELECT category, COUNT(*) AS count FROM skills WHERE category <> '' GROUP BY category ORDER BY count DESC, category")
    .all() as unknown as { category: string; count: number }[]
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

/** Set by the server: every mutation writes the lock, so the library stays reproducible. */
let mutationHook: (() => void) | null = null

export function setMutationHook(hook: (() => void) | null): void {
  mutationHook = hook
}

export function addJournal(action: string, payload: unknown): number {
  const result = getDb()
    .prepare('INSERT INTO journal (at, action, payload) VALUES (?, ?, ?)')
    .run(new Date().toISOString(), action, JSON.stringify(payload))
  mutationHook?.()
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

export interface PresetRow {
  id: number
  name: string
  agents: string[]
  created_at: string
}

function ensurePresets(): void {
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS presets (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL UNIQUE,
         agents TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`
    )
    .run()
}

export function listPresets(): PresetRow[] {
  ensurePresets()
  const rows = getDb().prepare('SELECT * FROM presets ORDER BY name').all() as unknown as PresetRow[]
  return rows.map((row) => ({ ...row, agents: JSON.parse(row.agents as unknown as string) as string[] }))
}

export function savePreset(name: string, agents: string[]): PresetRow {
  ensurePresets()
  getDb()
    .prepare(
      `INSERT INTO presets (name, agents, created_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET agents = excluded.agents`
    )
    .run(name, JSON.stringify(agents), new Date().toISOString())
  return listPresets().find((row) => row.name === name)!
}

export function deletePreset(id: number): boolean {
  ensurePresets()
  const info = getDb().prepare('DELETE FROM presets WHERE id = ?').run(id)
  return Number(info.changes) > 0
}

export interface WorkspaceRow {
  id: number
  name: string
  path: string
  created_at: string
}

function ensureWorkspaces(): void {
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS workspaces (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         path TEXT NOT NULL UNIQUE,
         created_at TEXT NOT NULL
       )`
    )
    .run()
}

export function listWorkspaces(): WorkspaceRow[] {
  ensureWorkspaces()
  return getDb().prepare('SELECT * FROM workspaces ORDER BY name').all() as unknown as WorkspaceRow[]
}

export function saveWorkspace(name: string, workspacePath: string): WorkspaceRow {
  ensureWorkspaces()
  getDb()
    .prepare(
      `INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET name = excluded.name`
    )
    .run(name, workspacePath, new Date().toISOString())
  return listWorkspaces().find((row) => row.path === workspacePath)!
}

export function deleteWorkspace(id: number): boolean {
  ensureWorkspaces()
  const info = getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  return Number(info.changes) > 0
}

/**
 * A source is where skills come from. `github` names an `owner/name` repository and is read over the
 * API; `local` names a checkout on this machine and is read from disk. The column holds both: for a
 * local source it is the absolute path.
 */
export type SourceKind = 'github' | 'local' | 'zip' | 'skillssh'

export interface SourceRow {
  id: number
  repo: string
  kind: SourceKind
  added_at: string
  last_commit: string | null
  last_release: string | null
  checked_at: string | null
}

function ensureSources(): void {
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS sources (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         repo TEXT NOT NULL UNIQUE,
         kind TEXT NOT NULL DEFAULT 'github',
         added_at TEXT NOT NULL,
         last_commit TEXT,
         last_release TEXT,
         checked_at TEXT
       )`
    )
    .run()
  // The table predates the second kind, and a database that already exists needs the column.
  const columns = getDb().prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'kind')) {
    getDb().prepare("ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'github'").run()
  }
}

export function listSources(): SourceRow[] {
  ensureSources()
  return getDb().prepare('SELECT * FROM sources ORDER BY repo').all() as unknown as SourceRow[]
}

export function saveSource(repo: string, kind: SourceKind = 'github'): SourceRow {
  ensureSources()
  getDb()
    .prepare(
      `INSERT INTO sources (repo, kind, added_at) VALUES (?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET kind = excluded.kind`
    )
    .run(repo, kind, new Date().toISOString())
  return listSources().find((row) => row.repo === repo)!
}

export function recordSourceCheck(repo: string, commit: string | null, release: string | null): void {
  ensureSources()
  getDb()
    .prepare('UPDATE sources SET last_commit = ?, last_release = ?, checked_at = ? WHERE repo = ?')
    .run(commit, release, new Date().toISOString(), repo)
}

export function deleteSource(id: number): boolean {
  ensureSources()
  const info = getDb().prepare('DELETE FROM sources WHERE id = ?').run(id)
  ensureSourceBaselines()
  getDb().prepare('DELETE FROM source_baselines WHERE source_id = ?').run(id)
  return Number(info.changes) > 0
}

/**
 * A baseline is the package as the source last wrote it. Without one there is no way to tell an
 * edit you made here from an update upstream, and replacing would quietly throw your work away.
 */
export interface SourceBaseline {
  source_id: number
  name: string
  hash: string
  files: string
  at: string
}

function ensureSourceBaselines(): void {
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS source_baselines (
         source_id INTEGER NOT NULL,
         name TEXT NOT NULL,
         hash TEXT NOT NULL,
         files TEXT NOT NULL,
         at TEXT NOT NULL,
         PRIMARY KEY (source_id, name)
       )`
    )
    .run()
}

export function setSourceBaseline(sourceId: number, name: string, hash: string, files: Record<string, string>): void {
  ensureSourceBaselines()
  getDb()
    .prepare(
      `INSERT INTO source_baselines (source_id, name, hash, files, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id, name) DO UPDATE SET hash = excluded.hash, files = excluded.files, at = excluded.at`
    )
    .run(sourceId, name, hash, JSON.stringify(files), new Date().toISOString())
}

export function getSourceBaseline(sourceId: number, name: string): { hash: string; files: Record<string, string> } | null {
  ensureSourceBaselines()
  const row = getDb()
    .prepare('SELECT hash, files FROM source_baselines WHERE source_id = ? AND name = ?')
    .get(sourceId, name) as { hash: string; files: string } | undefined
  if (!row) return null
  try {
    return { hash: row.hash, files: JSON.parse(row.files) as Record<string, string> }
  } catch {
    return { hash: row.hash, files: {} }
  }
}

export interface SourceEvent {
  id: number
  repo: string
  kind: 'commit' | 'release'
  value: string
  seen_at: string
  acknowledged: number
}

function ensureSourceEvents(): void {
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS source_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         repo TEXT NOT NULL,
         kind TEXT NOT NULL,
         value TEXT NOT NULL,
         seen_at TEXT NOT NULL,
         acknowledged INTEGER NOT NULL DEFAULT 0
       )`
    )
    .run()
}

export function recordSourceEvent(repo: string, kind: 'commit' | 'release', value: string): void {
  ensureSourceEvents()
  const existing = getDb()
    .prepare('SELECT id FROM source_events WHERE repo = ? AND kind = ? AND value = ?')
    .get(repo, kind, value) as { id?: number } | undefined
  if (existing?.id) return
  getDb()
    .prepare('INSERT INTO source_events (repo, kind, value, seen_at) VALUES (?, ?, ?, ?)')
    .run(repo, kind, value, new Date().toISOString())
}

export function listSourceEvents(includeAcknowledged = false): SourceEvent[] {
  ensureSourceEvents()
  const sql = includeAcknowledged
    ? 'SELECT * FROM source_events ORDER BY seen_at DESC LIMIT 200'
    : 'SELECT * FROM source_events WHERE acknowledged = 0 ORDER BY seen_at DESC LIMIT 200'
  return getDb().prepare(sql).all() as unknown as SourceEvent[]
}

export function acknowledgeSourceEvent(id: number): boolean {
  ensureSourceEvents()
  const info = getDb().prepare('UPDATE source_events SET acknowledged = 1 WHERE id = ?').run(id)
  return Number(info.changes) > 0
}

export interface LockRow {
  name: string
  version: string | null
  path: string
  root_path: string
  package_hash: string | null
  category: string | null
  tags: string | null
}

export function lockRows(): LockRow[] {
  return getDb()
    .prepare(
      `SELECT name, path, root_path, package_hash, category, tags
       FROM skills ORDER BY name, path`
    )
    .all() as unknown as LockRow[]
}

export function setSourceSkills(id: number, skills: string[]): boolean {
  ensureSources()
  const columns = getDb().prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'skills')) {
    getDb().prepare('ALTER TABLE sources ADD COLUMN skills TEXT').run()
  }
  const info = getDb().prepare('UPDATE sources SET skills = ? WHERE id = ?').run(JSON.stringify(skills), id)
  return Number(info.changes) > 0
}

export function sourceSkills(id: number): string[] {
  ensureSources()
  const columns = getDb().prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'skills')) return []
  const row = getDb().prepare('SELECT skills FROM sources WHERE id = ?').get(id) as { skills?: string | null } | undefined
  if (!row?.skills) return []
  try {
    return JSON.parse(row.skills) as string[]
  } catch {
    return []
  }
}

/** How many skills sit in each root's own `.archive` folder. */
export function archivedByRoot(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT s.root_path, COUNT(*) AS n FROM skills s WHERE ${ARCHIVED_SQL} GROUP BY s.root_path`)
    .all() as Array<{ root_path: string; n: number }>
  const out: Record<string, number> = {}
  for (const row of rows) out[row.root_path] = row.n
  return out
}
