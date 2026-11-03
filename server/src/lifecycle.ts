import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config'
import { addJournal, getDb, removeByPath, saveOne } from './db'
import { parseSkill } from './skill'

export interface TrashRow {
  id: number
  skill_path: string
  name: string
  root_path: string
  scope: string
  moved_to: string
  at: string
  expires_at: string
  restored_at: string | null
}

export interface Settings {
  archiveDir: string
  trashDays: number
  /** Which model the merge pass asks. Stored here so a repair on another machine matches. */
  mergeProvider: string
  mergeModel: string
}

const DEFAULT_TRASH_DAYS = 30

/** Settings live in meta so a second machine can share them without a config file. */
export function readSettings(): Settings {
  const db = getDb()
  const rows = db
    .prepare("SELECT key, value FROM meta WHERE key IN ('archive_dir', 'trash_days', 'merge_provider', 'merge_model')")
    .all() as {
    key: string
    value: string
  }[]
  const found = new Map(rows.map((row) => [row.key, row.value]))
  return {
    archiveDir: found.get('archive_dir') ?? path.join(DATA_DIR, 'archive'),
    trashDays: Number(found.get('trash_days') ?? DEFAULT_TRASH_DAYS),
    mergeProvider: found.get('merge_provider') ?? 'opencode-go',
    mergeModel: found.get('merge_model') ?? 'deepseek-v4.1-flash'
  }
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const db = getDb()
  const write = (key: string, value: string) =>
    db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value)
  if (patch.archiveDir !== undefined) write('archive_dir', patch.archiveDir)
  if (patch.trashDays !== undefined) write('trash_days', String(patch.trashDays))
  if (patch.mergeProvider !== undefined) write('merge_provider', patch.mergeProvider)
  if (patch.mergeModel !== undefined) write('merge_model', patch.mergeModel)
  return readSettings()
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function insideRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Moving a folder across volumes cannot rename, so fall back to copy-then-move. */
function moveDirectory(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true })
  fs.rmSync(from, { recursive: true, force: true })
}

export interface ArchiveResult {
  ok: boolean
  reason?: string
  trashedTo?: string
  trashId?: number
  journalId?: number
}

/**
 * Archive is a move, never a delete: the package leaves its agent folder, the index
 * forgets it, and the trash row is what brings it back.
 */
export function archiveSkill(id: number, reason = 'manual'): ArchiveResult {
  const db = getDb()
  const row = db
    .prepare('SELECT id, path, real_path, name, root_path, scope FROM skills WHERE id = ?')
    .get(id) as { id: number; path: string; real_path: string; name: string; root_path: string; scope: string } | undefined
  if (!row) return { ok: false, reason: 'not-found' }

  const source = row.real_path || row.path
  if (!fs.existsSync(source)) return { ok: false, reason: 'missing-on-disk' }
  // A link is not the package: archiving it would take the target with it.
  if (fs.lstatSync(row.path).isSymbolicLink()) return { ok: false, reason: 'is-link' }

  const settings = readSettings()
  const destination = path.join(settings.archiveDir, `${stamp()}-${row.name}`)
  try {
    moveDirectory(source, destination)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }

  const at = new Date().toISOString()
  const expires = new Date(Date.parse(at) + settings.trashDays * 24 * 60 * 60 * 1000).toISOString()
  const inserted = db
    .prepare(`
      INSERT INTO trash (skill_path, name, root_path, scope, moved_to, at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(row.path, row.name, row.root_path, row.scope, destination, at, expires)
  const trashId = Number(inserted.lastInsertRowid)

  removeByPath(row.path)
  const journalId = addJournal('archive', {
    trashId,
    from: row.path,
    to: destination,
    name: row.name,
    root: row.root_path,
    scope: row.scope,
    reason
  })
  return { ok: true, trashedTo: destination, trashId, journalId }
}

export function listTrash(): TrashRow[] {
  return getDb()
    .prepare('SELECT * FROM trash WHERE restored_at IS NULL ORDER BY id DESC')
    .all() as unknown as TrashRow[]
}

export interface RestoreResult {
  ok: boolean
  reason?: string
  restoredTo?: string
  journalId?: number
}

export function restoreTrash(trashId: number): RestoreResult {
  const db = getDb()
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(trashId) as TrashRow | undefined
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.restored_at) return { ok: false, reason: 'already-restored' }
  if (!fs.existsSync(row.moved_to)) return { ok: false, reason: 'archive-copy-missing' }
  if (fs.existsSync(row.skill_path)) return { ok: false, reason: 'target-occupied' }

  try {
    moveDirectory(row.moved_to, row.skill_path)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }

  const skill = parseSkill(row.skill_path, row.root_path, row.scope)
  if (skill) saveOne(row.root_path, row.scope, skill)

  db.prepare('UPDATE trash SET restored_at = ? WHERE id = ?').run(new Date().toISOString(), trashId)
  const journalId = addJournal('restore', {
    trashId,
    to: row.skill_path,
    from: row.moved_to,
    name: row.name,
    root: row.root_path
  })
  return { ok: true, restoredTo: row.skill_path, journalId }
}

/**
 * Purge is irreversible, so it goes to the operating system's Recycle Bin rather than
 * being unlinked. On Windows that means SHFileOperation via python, which does not
 * depend on a console and cannot be undone by accident inside the app.
 */
function recycle(target: string): { ok: boolean; reason?: string } {
  const script = `
import ctypes, sys
from ctypes import wintypes
path = sys.argv[1]
SHFileOperationW = ctypes.windll.shell32.SHFileOperationW
class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]
op = SHFILEOPSTRUCTW()
op.wFunc = 3
op.pFrom = path + "\\0"
op.fFlags = 0x0040 | 0x0010 | 0x0004
sys.exit(SHFileOperationW(ctypes.byref(op)))
`
  const result = spawnSync('python', ['-c', script, target], { windowsHide: true, timeout: 60_000 })
  if (result.status === 0) return { ok: true }
  return { ok: false, reason: result.stderr?.toString() || `exit ${result.status}` }
}

export function purgeTrash(trashId: number): { ok: boolean; reason?: string; journalId?: number } {
  const db = getDb()
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(trashId) as TrashRow | undefined
  if (!row) return { ok: false, reason: 'not-found' }
  if (!fs.existsSync(row.moved_to)) {
    db.prepare('DELETE FROM trash WHERE id = ?').run(trashId)
    return { ok: true }
  }
  if (!insideRoot(row.moved_to, readSettings().archiveDir)) return { ok: false, reason: 'outside-archive' }
  const outcome = recycle(row.moved_to)
  if (!outcome.ok) return { ok: false, reason: outcome.reason }
  db.prepare('DELETE FROM trash WHERE id = ?').run(trashId)
  const journalId = addJournal('purge', { trashId, path: row.moved_to, name: row.name })
  return { ok: true, journalId }
}

/** Nothing inside the app deletes on a timer; this only reports what has expired. */
export function expiredTrash(): TrashRow[] {
  const now = new Date().toISOString()
  return listTrash().filter((row) => row.expires_at <= now)
}

export function undoJournal(journalId: number): { ok: boolean; reason?: string; action?: string } {
  const db = getDb()
  const row = db.prepare('SELECT * FROM journal WHERE id = ?').get(journalId) as
    | { id: number; action: string; payload: string; undone_at: string | null }
    | undefined
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.undone_at) return { ok: false, reason: 'already-undone' }
  const payload = JSON.parse(row.payload) as {
    snapshots?: Array<{ name: string; target: string; snapshot: string }>
    trashId?: number
    target?: string
    from?: string
    to?: string
    snapshot?: string | null
    name?: string
  }

  if (row.action === 'archive' && payload.trashId) {
    const restored = restoreTrash(payload.trashId)
    if (!restored.ok) return { ok: false, reason: restored.reason }
  } else if (row.action === 'restore' && payload.trashId) {
    const trashed = db.prepare('SELECT skill_path FROM trash WHERE id = ?').get(payload.trashId) as
      | { skill_path: string }
      | undefined
    if (!trashed) return { ok: false, reason: 'trash-row-missing' }
    const live = db.prepare('SELECT id FROM skills WHERE path = ?').get(trashed.skill_path) as
      | { id: number }
      | undefined
    if (!live) return { ok: false, reason: 'skill-missing' }
    const archived = archiveSkill(live.id, 'undo-restore')
    if (!archived.ok) return { ok: false, reason: archived.reason }
  } else if (row.action === 'workspace-promote' && payload.target) {
    // Undo is the same act in reverse: the library copy goes, and the snapshot comes back if the
    // promotion replaced a package rather than creating one.
    try {
      if (payload.snapshot && fs.existsSync(payload.snapshot)) {
        fs.rmSync(payload.target, { recursive: true, force: true })
        fs.cpSync(payload.snapshot, payload.target, { recursive: true })
        fs.rmSync(payload.snapshot, { recursive: true, force: true })
      } else {
        fs.rmSync(payload.target, { recursive: true, force: true })
      }
    } catch (error) {
      return { ok: false, reason: (error as Error).message }
    }
  } else if (row.action === 'source-replace') {
    // A source replaced packages it had snapshotted first. Undo puts every one of them back, and a
    // package the replace created has no snapshot, so undo removes it.
    const written = (payload as { snapshots?: Array<{ name: string; target: string; snapshot: string }> }).snapshots ?? []
    try {
      for (const entry of written) {
        if (entry.snapshot && fs.existsSync(entry.snapshot)) {
          fs.rmSync(entry.target, { recursive: true, force: true })
          fs.cpSync(entry.snapshot, entry.target, { recursive: true })
          fs.rmSync(entry.snapshot, { recursive: true, force: true })
          const parsed = parseSkill(entry.target, path.dirname(entry.target), 'library')
          if (parsed) saveOne(path.dirname(entry.target), 'library', parsed)
        } else {
          removeByPath(entry.target)
          fs.rmSync(entry.target, { recursive: true, force: true })
        }
      }
    } catch (error) {
      return { ok: false, reason: (error as Error).message }
    }
  } else if (row.action === 'enable' || row.action === 'disable') {
    return { ok: false, reason: 'handled-by-placements' }
  } else {
    return { ok: false, reason: `cannot undo ${row.action}` }
  }

  db.prepare('UPDATE journal SET undone_at = ? WHERE id = ?').run(new Date().toISOString(), journalId)
  addJournal('undo', { journalId, action: row.action })
  return { ok: true, action: row.action }
}
