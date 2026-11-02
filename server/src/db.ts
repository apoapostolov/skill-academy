import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './config'
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

let database: DatabaseSync | undefined

function migrate(db: DatabaseSync): void {
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

export function getDb(): DatabaseSync {
  if (!database) {
    database = new DatabaseSync(DB_PATH)
    migrate(database)
  }
  return database
}

export function saveScan(results: RootScan[]): string {
  const db = getDb()
  const at = new Date().toISOString()
  const upsert = db.prepare(`
    INSERT INTO roots (path, scope, owners, present, skill_count, truncated, last_scan_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      scope = excluded.scope,
      owners = excluded.owners,
      present = excluded.present,
      skill_count = excluded.skill_count,
      truncated = excluded.truncated,
      last_scan_at = excluded.last_scan_at,
      error = excluded.error
  `)
  for (const row of results) {
    upsert.run(
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
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'last_scan_at',
    at
  )
  return at
}

export function readRoots(): RootRow[] {
  return getDb().prepare('SELECT * FROM roots ORDER BY path').all() as unknown as RootRow[]
}

export function readMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
  return row?.value ?? null
}
