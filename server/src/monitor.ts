/**
 * Versioning monitor: one record per installed skill, checked against the repository it came from.
 *
 * The record is the unit of truth, not the repository. A repository is a container; an installation
 * is a promise that a specific skill came from a specific commit, and that promise is only worth
 * something if the bytes at install time were written down.
 *
 * Network cost is the design constraint: `installation_files` stores the git blob sha of every file
 * at install time, and GitHub reports the same identifier for a later tree, so an unchanged file is
 * proven unchanged by comparing two short strings. Content is fetched only for files whose blob
 * moved, and one tree fetch serves every installation in a repository.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDb } from './db'
import { DATA_DIR } from './config'
import { getKey } from './secrets'

/* ---------------------------------- schema --------------------------------- */

let ensured = false

export function ensureMonitorTables(): void {
  if (ensured) return
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS installations (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         repo TEXT NOT NULL,
         remote_path TEXT NOT NULL,
         name TEXT NOT NULL,
         ref_kind TEXT NOT NULL DEFAULT 'commit',
         ref TEXT NOT NULL,
         tag TEXT,
         installed_at TEXT NOT NULL,
         installed_hash TEXT,
         package_hash TEXT,
         library_path TEXT NOT NULL,
         version TEXT,
         pin_ref TEXT,
         pin_note TEXT,
         baseline_lost INTEGER NOT NULL DEFAULT 0,
         policy_channel TEXT NOT NULL DEFAULT 'release',
         policy_auto TEXT NOT NULL DEFAULT 'off',
         last_check_at TEXT,
         last_state TEXT,
         last_remote_ref TEXT,
         last_event_at TEXT,
         UNIQUE(repo, remote_path)
       )`
    )
    .run()
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS installation_files (
         installation_id INTEGER NOT NULL,
         path TEXT NOT NULL,
         blob_sha TEXT NOT NULL,
         bytes INTEGER NOT NULL,
         hash TEXT NOT NULL,
         PRIMARY KEY (installation_id, path)
       )`
    )
    .run()
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS installation_agents (
         installation_id INTEGER NOT NULL,
         agent TEXT NOT NULL,
         mode TEXT NOT NULL,
         target_path TEXT NOT NULL,
         placed_at TEXT NOT NULL,
         PRIMARY KEY (installation_id, agent)
       )`
    )
    .run()
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS repo_snapshots (
         repo TEXT NOT NULL,
         ref TEXT NOT NULL,
         tree_sha TEXT,
         etag TEXT,
         fetched_at TEXT NOT NULL,
         truncated INTEGER NOT NULL DEFAULT 0,
         release_tag TEXT,
         release_name TEXT,
         release_at TEXT,
         prerelease INTEGER NOT NULL DEFAULT 0,
         archived INTEGER NOT NULL DEFAULT 0,
         default_branch TEXT,
         unreachable INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (repo, ref)
       )`
    )
    .run()
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS monitor_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         installation_id INTEGER,
         repo TEXT NOT NULL,
         kind TEXT NOT NULL,
         from_ref TEXT,
         to_ref TEXT,
         summary TEXT NOT NULL,
         severity TEXT NOT NULL,
         seen_at TEXT NOT NULL,
         acknowledged INTEGER NOT NULL DEFAULT 0
       )`
    )
    .run()
  ensured = true
}

/* ---------------------------------- types ---------------------------------- */

export type Channel = 'release' | 'head' | 'pinned'
export type AutoPolicy = 'off' | 'notify' | 'apply-minor' | 'apply-any'
export type Severity = 'info' | 'attention' | 'destructive'
export type State = 'up-to-date' | 'behind' | 'local-drift' | 'conflict' | 'gone' | 'unreachable' | 'unknown'

export interface InstallationRow {
  id: number
  repo: string
  remote_path: string
  name: string
  ref_kind: string
  ref: string
  tag: string | null
  installed_at: string
  installed_hash: string | null
  package_hash: string | null
  library_path: string
  version: string | null
  pin_ref: string | null
  pin_note: string | null
  baseline_lost: number
  policy_channel: Channel
  policy_auto: AutoPolicy
  last_check_at: string | null
  last_state: string | null
  last_remote_ref: string | null
  last_event_at: string | null
}

export interface FileRow {
  installation_id: number
  path: string
  blob_sha: string
  bytes: number
  hash: string
}

export interface TreeFile {
  path: string
  blob: string
  bytes: number
}

/* --------------------------------- helpers --------------------------------- */

/** The identifier GitHub uses for a blob, computed locally so a baseline needs no network. */
export function gitBlobSha(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

export function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'skill-academy'
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? getKey('github')
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

export interface RateLimit {
  remaining: number | null
  limit: number | null
  resetAt: string | null
}

function readRateLimit(headers: Headers, into: RateLimit): void {
  const remaining = headers.get('x-ratelimit-remaining')
  const limit = headers.get('x-ratelimit-limit')
  const reset = headers.get('x-ratelimit-reset')
  if (remaining) into.remaining = Number(remaining)
  if (limit) into.limit = Number(limit)
  if (reset) into.resetAt = new Date(Number(reset) * 1000).toISOString()
}

export const rateLimit: RateLimit = { remaining: null, limit: null, resetAt: null }

export interface RequestLog {
  requests: number
  conditional: number
}

export const lastRun: RequestLog = { requests: 0, conditional: 0 }

async function api(url: string, init: RequestInit = {}): Promise<Response> {
  lastRun.requests += 1
  const response = await fetch(url, { ...init, headers: { ...githubHeaders(), ...(init.headers ?? {}) } })
  readRateLimit(response.headers, rateLimit)
  return response
}

function walkFiles(dir: string, prefix = ''): Array<{ path: string; full: string }> {
  const out: Array<{ path: string; full: string }> = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(full, relative))
    else if (entry.isFile()) out.push({ path: relative, full })
  }
  return out
}

function frontmatterVersion(text: string): string | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  const line = match[1].split(/\r?\n/).find((entry) => /^version:/i.test(entry.trim()))
  if (!line) return null
  return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '') || null
}

function packageHashOf(files: FileRow[]): string {
  const lines = files
    .map((file) => `${file.path}\0${file.hash}`)
    .sort()
    .join('\n')
  return sha256(lines)
}

/* ------------------------------- installations ------------------------------ */

export interface NewInstallation {
  repo: string
  remotePath: string
  ref: string
  refKind?: 'commit' | 'tag' | 'branch'
  tag?: string | null
  libraryPath: string
  channel?: Channel
  agents?: Array<{ agent: string; mode: string; targetPath: string }>
}

/**
 * Written at install time, before anything can change: this is the only moment the bytes are known
 * to be exactly what upstream had.
 */
export function recordInstallation(input: NewInstallation): number {
  ensureMonitorTables()
  const repo = input.repo
  const remotePath = input.remotePath.replace(/\/+$/, '')
  const name = path.basename(remotePath)
  const files: FileRow[] = walkFiles(input.libraryPath).map((entry) => {
    const content = fs.readFileSync(entry.full)
    return {
      installation_id: 0,
      path: entry.path,
      blob_sha: gitBlobSha(content),
      bytes: content.length,
      hash: sha256(content)
    }
  })
  const skillFile = files.find((file) => file.path === 'SKILL.md')
  const installedHash = skillFile?.hash ?? null
  const version = skillFile
    ? frontmatterVersion(fs.readFileSync(path.join(input.libraryPath, 'SKILL.md'), 'utf8'))
    : null

  const db = getDb()
  db.prepare(
    `INSERT INTO installations
       (repo, remote_path, name, ref_kind, ref, tag, installed_at, installed_hash, package_hash,
        library_path, version, policy_channel, last_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')
     ON CONFLICT(repo, remote_path) DO UPDATE SET
       ref = excluded.ref, ref_kind = excluded.ref_kind, tag = excluded.tag,
       installed_at = excluded.installed_at, installed_hash = excluded.installed_hash,
       package_hash = excluded.package_hash, library_path = excluded.library_path,
       version = excluded.version, last_state = 'unknown'`
  ).run(
    repo,
    remotePath,
    name,
    input.refKind ?? 'commit',
    input.ref,
    input.tag ?? null,
    new Date().toISOString(),
    installedHash,
    packageHashOf(files),
    input.libraryPath,
    version,
    input.channel ?? 'release'
  )
  const row = db
    .prepare('SELECT id FROM installations WHERE repo = ? AND remote_path = ?')
    .get(repo, remotePath) as { id: number }

  db.prepare('DELETE FROM installation_files WHERE installation_id = ?').run(row.id)
  const insert = db.prepare(
    'INSERT INTO installation_files (installation_id, path, blob_sha, bytes, hash) VALUES (?, ?, ?, ?, ?)'
  )
  for (const file of files) insert.run(row.id, file.path, file.blob_sha, file.bytes, file.hash)
  db.prepare('DELETE FROM installation_agents WHERE installation_id = ?').run(row.id)
  for (const agent of input.agents ?? []) {
    db.prepare(
      'INSERT INTO installation_agents (installation_id, agent, mode, target_path, placed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(row.id, agent.agent, agent.mode, agent.targetPath, new Date().toISOString())
  }
  return row.id
}

export function listInstallations(): InstallationRow[] {
  ensureMonitorTables()
  return getDb()
    .prepare('SELECT * FROM installations ORDER BY repo, remote_path')
    .all() as unknown as InstallationRow[]
}

export function installationById(id: number): InstallationRow | undefined {
  ensureMonitorTables()
  return getDb().prepare('SELECT * FROM installations WHERE id = ?').get(id) as unknown as InstallationRow | undefined
}

function baselineFiles(id: number): FileRow[] {
  return getDb()
    .prepare('SELECT * FROM installation_files WHERE installation_id = ? ORDER BY path')
    .all(id) as unknown as FileRow[]
}

/** The local copy as it sits now, keyed by path, so drift is a comparison of two short strings. */
export function localFiles(installation: InstallationRow): FileRow[] {
  return walkFiles(installation.library_path).map((entry) => {
    const content = fs.readFileSync(entry.full)
    return {
      installation_id: installation.id,
      path: entry.path,
      blob_sha: gitBlobSha(content),
      bytes: content.length,
      hash: sha256(content)
    }
  })
}

export interface DriftReport {
  localChanged: string[]
  localAdded: string[]
  localRemoved: string[]
}

export function localDrift(installation: InstallationRow): DriftReport {
  const baseline = new Map(baselineFiles(installation.id).map((file) => [file.path, file]))
  const current = new Map(localFiles(installation).map((file) => [file.path, file]))
  const localChanged: string[] = []
  const localAdded: string[] = []
  const localRemoved: string[] = []
  for (const [filePath, file] of current) {
    const base = baseline.get(filePath)
    if (!base) localAdded.push(filePath)
    else if (base.hash !== file.hash) localChanged.push(filePath)
  }
  for (const filePath of baseline.keys()) if (!current.has(filePath)) localRemoved.push(filePath)
  return { localChanged, localAdded, localRemoved }
}

/* ------------------------------ remote lookups ----------------------------- */

export interface RepoMeta {
  canonical: string
  defaultBranch: string
  archived: boolean
  unreachable: boolean
  error?: string
}

/** `HEAD` and a branch name are both aliases for a commit; the baseline stores the commit. */
export async function resolveRef(repo: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase()
  const response = await api(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`)
  if (!response.ok) return ref
  const data = (await response.json()) as { sha?: string }
  return data.sha ? data.sha.toLowerCase() : ref
}

export async function repoMeta(repo: string): Promise<RepoMeta> {
  const response = await api(`https://api.github.com/repos/${repo}`)
  if (response.status === 404) {
    return { canonical: repo, defaultBranch: 'main', archived: false, unreachable: true, error: 'repository not found' }
  }
  if (!response.ok) {
    return { canonical: repo, defaultBranch: 'main', archived: false, unreachable: false, error: `github ${response.status}` }
  }
  const data = (await response.json()) as { full_name: string; default_branch: string; archived: boolean }
  return { canonical: data.full_name, defaultBranch: data.default_branch, archived: data.archived, unreachable: false }
}

export interface ReleaseInfo {
  tag: string | null
  name: string | null
  at: string | null
  prerelease: boolean
}

export async function latestRelease(repo: string, allowPrerelease = false): Promise<ReleaseInfo> {
  const response = await api(`https://api.github.com/repos/${repo}/releases?per_page=20`)
  if (!response.ok) return { tag: null, name: null, at: null, prerelease: false }
  const data = (await response.json()) as Array<{ tag_name: string; name: string | null; published_at: string | null; prerelease: boolean; draft: boolean }>
  const release = data.find((entry) => !entry.draft && (allowPrerelease || !entry.prerelease))
  if (!release) return { tag: null, name: null, at: null, prerelease: false }
  return { tag: release.tag_name, name: release.name, at: release.published_at, prerelease: release.prerelease }
}

export interface TreeResult {
  files: TreeFile[]
  truncated: boolean
  treeSha: string | null
  etag: string | null
  notModified: boolean
  error?: string
}

/** One tree fetch per repository and ref; a cached ETag turns an unchanged repository into zero cost. */
export async function fetchTree(repo: string, ref: string, allowCache = true): Promise<TreeResult> {
  ensureMonitorTables()
  const cached = getDb()
    .prepare('SELECT * FROM repo_snapshots WHERE repo = ? AND ref = ?')
    .get(repo, ref) as { etag: string | null; fetched_at: string; tree_sha: string | null; truncated: number } | undefined
  const headers: Record<string, string> = {}
  if (allowCache && cached?.etag) {
    headers['if-none-match'] = cached.etag
    lastRun.conditional += 1
  }
  const response = await api(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { headers })
  if (response.status === 304 && cached) {
    const stored = getDb()
      .prepare('SELECT path FROM installation_files WHERE installation_id IN (SELECT id FROM installations WHERE repo = ?) LIMIT 0')
    void stored
    return { files: [], truncated: Boolean(cached.truncated), treeSha: cached.tree_sha, etag: cached.etag, notModified: true }
  }
  if (!response.ok) {
    return { files: [], truncated: false, treeSha: null, etag: null, notModified: false, error: `github ${response.status}` }
  }
  const data = (await response.json()) as {
    sha?: string
    truncated?: boolean
    tree?: Array<{ path: string; type: string; sha: string; size?: number }>
  }
  const files = (data.tree ?? [])
    .filter((entry) => entry.type === 'blob' || entry.type === 'symlink')
    .map((entry) => ({ path: entry.path, blob: entry.sha, bytes: entry.size ?? 0 }))
  getDb()
    .prepare(
      `INSERT INTO repo_snapshots (repo, ref, tree_sha, etag, fetched_at, truncated)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, ref) DO UPDATE SET tree_sha = excluded.tree_sha, etag = excluded.etag,
         fetched_at = excluded.fetched_at, truncated = excluded.truncated`
    )
    .run(repo, ref, data.sha ?? null, response.headers.get('etag'), new Date().toISOString(), data.truncated ? 1 : 0)
  return {
    files,
    truncated: Boolean(data.truncated),
    treeSha: data.sha ?? null,
    etag: response.headers.get('etag'),
    notModified: false
  }
}

export function subtree(tree: TreeFile[], remotePath: string): TreeFile[] {
  const prefix = remotePath.replace(/\/+$/, '') + '/'
  return tree
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), blob: file.blob, bytes: file.bytes }))
}

/* -------------------------------- comparison ------------------------------- */

export type FileStatus = 'same' | 'changed' | 'added' | 'removed' | 'moved'

export interface DiffFile {
  path: string
  remotePath: string | null
  status: FileStatus
  installedBlob: string | null
  remoteBlob: string | null
  installedBytes: number | null
  remoteBytes: number | null
  movedFrom?: string
}

export interface PackageDiff {
  files: DiffFile[]
  changed: number
  added: number
  removed: number
  moved: number
  same: number
  percent: number
  remotePackageHash: string | null
  truncated: boolean
}

/**
 * Package to package, from short strings only. A file that kept its blob sha kept its bytes, so the
 * comparison never needs content except to prove a move.
 */
export function packageDiff(installation: InstallationRow, remote: TreeFile[]): PackageDiff {
  const baseline = baselineFiles(installation.id)
  const baseMap = new Map(baseline.map((file) => [file.path, file]))
  const remoteMap = new Map(remote.map((file) => [file.path, file]))
  const files: DiffFile[] = []
  const removedFrom: Array<{ path: string; blob: string; bytes: number }> = []

  for (const [filePath, remoteFile] of remoteMap) {
    const base = baseMap.get(filePath)
    if (!base) {
      files.push({
        path: filePath,
        remotePath: filePath,
        status: 'added',
        installedBlob: null,
        remoteBlob: remoteFile.blob,
        installedBytes: null,
        remoteBytes: remoteFile.bytes
      })
      continue
    }
    files.push({
      path: filePath,
      remotePath: filePath,
      status: base.blob_sha === remoteFile.blob ? 'same' : 'changed',
      installedBlob: base.blob_sha,
      remoteBlob: remoteFile.blob,
      installedBytes: base.bytes,
      remoteBytes: remoteFile.bytes
    })
  }
  for (const [filePath, base] of baseMap) {
    if (remoteMap.has(filePath)) continue
    removedFrom.push({ path: filePath, blob: base.blob_sha, bytes: base.bytes })
  }
  // A path that disappeared whose blob still exists elsewhere is a move, not a delete plus an add.
  for (const gone of removedFrom) {
    const added = files.find((file) => file.status === 'added' && file.remoteBlob === gone.blob)
    if (added) {
      added.status = 'moved'
      added.movedFrom = gone.path
      continue
    }
    files.push({
      path: gone.path,
      remotePath: null,
      status: 'removed',
      installedBlob: gone.blob,
      remoteBlob: null,
      installedBytes: gone.bytes,
      remoteBytes: null
    })
  }

  const count = (status: FileStatus) => files.filter((file) => file.status === status).length
  const changedFiles = files.filter((file) => file.status !== 'same')
  const remoteHash = packageHashOf(
    remote.map((file) => ({ installation_id: 0, path: file.path, blob_sha: file.blob, bytes: file.bytes, hash: file.blob }))
  )
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    changed: count('changed'),
    added: count('added'),
    removed: count('removed'),
    moved: count('moved'),
    same: count('same'),
    percent: files.length ? Math.round((changedFiles.length / files.length) * 100) : 0,
    remotePackageHash: remoteHash,
    truncated: false
  }
}

/* ---------------------------------- events --------------------------------- */

export interface MonitorEvent {
  id: number
  installation_id: number | null
  repo: string
  kind: string
  from_ref: string | null
  to_ref: string | null
  summary: string
  severity: Severity
  seen_at: string
  acknowledged: number
}

function addEvent(input: {
  installationId: number | null
  repo: string
  kind: string
  fromRef?: string | null
  toRef?: string | null
  summary: string
  severity: Severity
}): boolean {
  ensureMonitorTables()
  const db = getDb()
  const existing = db
    .prepare(
      `SELECT id FROM monitor_events
       WHERE repo = ? AND kind = ? AND COALESCE(installation_id, 0) = ? AND COALESCE(to_ref, '') = ?`
    )
    .get(input.repo, input.kind, input.installationId ?? 0, input.toRef ?? '') as { id?: number } | undefined
  if (existing?.id) return false
  db.prepare(
    `INSERT INTO monitor_events (installation_id, repo, kind, from_ref, to_ref, summary, severity, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.installationId,
    input.repo,
    input.kind,
    input.fromRef ?? null,
    input.toRef ?? null,
    input.summary,
    input.severity,
    new Date().toISOString()
  )
  if (input.installationId) {
    db.prepare('UPDATE installations SET last_event_at = ? WHERE id = ?').run(new Date().toISOString(), input.installationId)
  }
  return true
}

export function listEvents(includeAcknowledged = false): MonitorEvent[] {
  ensureMonitorTables()
  const sql = includeAcknowledged
    ? 'SELECT * FROM monitor_events ORDER BY seen_at DESC LIMIT 400'
    : 'SELECT * FROM monitor_events WHERE acknowledged = 0 ORDER BY seen_at DESC LIMIT 400'
  return getDb().prepare(sql).all() as unknown as MonitorEvent[]
}

export function acknowledgeEvents(ids: number[]): number {
  ensureMonitorTables()
  const statement = getDb().prepare('UPDATE monitor_events SET acknowledged = 1 WHERE id = ?')
  let changed = 0
  for (const id of ids) changed += Number(statement.run(id).changes)
  return changed
}

/* --------------------------------- the check ------------------------------- */

export interface CheckOutcome {
  installation: InstallationRow
  meta: RepoMeta
  target: { ref: string; kind: 'release' | 'head' | 'pinned' | 'tag' }
  diff: PackageDiff | null
  drift: DriftReport
  localVersion: string | null
  remoteVersion: string | null
  state: State
  kinds: string[]
  error?: string
  skipped?: string
}

export interface CheckSummary {
  checkedAt: string
  requests: number
  conditional: number
  rateLimit: RateLimit
  outcomes: CheckOutcome[]
  byRepo: Record<string, { meta: RepoMeta; target: string; newSkills: string[] }>
  events: number
}

function semverParts(version: string | null): [number, number, number] | null {
  if (!version) return null
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function classify(input: {
  diff: PackageDiff
  drift: DriftReport
  installedRef: string
  targetRef: string
  localVersion: string | null
  remoteVersion: string | null
  goneUpstream: boolean
}): { state: State; kinds: string[] } {
  const kinds: string[] = []
  const driftFiles = input.drift.localChanged.length + input.drift.localAdded.length + input.drift.localRemoved.length
  const upstreamFiles = input.diff.changed + input.diff.added + input.diff.removed + input.diff.moved

  if (input.goneUpstream) return { state: 'gone', kinds: ['gone-upstream'] }

  if (upstreamFiles > 0) {
    kinds.push('content-change')
    const local = semverParts(input.localVersion)
    const remote = semverParts(input.remoteVersion)
    if (local && remote) {
      const localRank = local[0] * 10_000 + local[1] * 100 + local[2]
      const remoteRank = remote[0] * 10_000 + remote[1] * 100 + remote[2]
      if (remoteRank < localRank) kinds.push('version-regression')
      else if (remoteRank === localRank) kinds.push('silent-change')
    } else if (input.localVersion && input.localVersion === input.remoteVersion) {
      kinds.push('silent-change')
    }
  }
  if (driftFiles > 0) kinds.push('local-drift')
  if (upstreamFiles > 0 && driftFiles > 0) kinds.push('conflict')

  if (kinds.includes('conflict')) return { state: 'conflict', kinds }
  if (kinds.includes('local-drift')) return { state: 'local-drift', kinds }
  if (upstreamFiles > 0) return { state: 'behind', kinds }
  if (input.installedRef !== input.targetRef) return { state: 'up-to-date', kinds }
  return { state: 'up-to-date', kinds }
}

async function targetFor(installation: InstallationRow, meta: RepoMeta, release: ReleaseInfo): Promise<{ ref: string; kind: 'release' | 'head' | 'pinned' | 'tag' }> {
  if (installation.pin_ref) return { ref: installation.pin_ref, kind: 'pinned' }
  if (installation.policy_channel === 'head') return { ref: meta.defaultBranch, kind: 'head' }
  if (release.tag) return { ref: release.tag, kind: 'release' }
  return { ref: meta.defaultBranch, kind: 'head' }
}

export async function checkInstallation(installation: InstallationRow, options: { allowCache?: boolean } = {}): Promise<CheckOutcome> {
  const meta = await repoMeta(installation.repo)
  const base: CheckOutcome = {
    installation,
    meta,
    target: { ref: installation.ref, kind: 'pinned' },
    diff: null,
    drift: localDrift(installation),
    localVersion: installation.version,
    remoteVersion: null,
    state: 'unknown',
    kinds: []
  }
  if (meta.unreachable) return { ...base, state: 'unreachable', error: meta.error }

  const release = await latestRelease(installation.repo)
  const target = await targetFor(installation, meta, release)
  base.target = target
  const tree = await fetchTree(installation.repo, target.ref, options.allowCache ?? true)
  if (tree.error) return { ...base, state: 'unreachable', error: tree.error }

  let remoteFiles = subtree(tree.files, installation.remote_path)
  const goneUpstream = remoteFiles.length === 0

  const diff = packageDiff(installation, remoteFiles)
  diff.truncated = tree.truncated

  // The remote SKILL.md is the only file worth fetching: its version drives regression and silence.
  const skillEntry = remoteFiles.find((file) => file.path === 'SKILL.md')
  if (skillEntry && !goneUpstream) {
    const blob = await fetchBlob(installation.repo, skillEntry.blob)
    if (blob !== null) base.remoteVersion = frontmatterVersion(blob)
  }

  const classified = classify({
    diff,
    drift: base.drift,
    installedRef: installation.ref,
    targetRef: target.ref,
    localVersion: base.localVersion,
    remoteVersion: base.remoteVersion,
    goneUpstream
  })

  const summaryBits: string[] = []
  if (classified.kinds.includes('content-change')) {
    summaryBits.push(`${diff.changed + diff.added + diff.removed + diff.moved} file(s) changed at ${target.ref.slice(0, 8)}`)
  }
  if (classified.kinds.includes('silent-change')) summaryBits.push(`same version ${base.localVersion ?? '—'}, different bytes`)
  if (classified.kinds.includes('version-regression')) summaryBits.push(`upstream went back to ${base.remoteVersion} from ${base.localVersion}`)
  if (classified.kinds.includes('local-drift')) summaryBits.push(`${base.drift.localChanged.length + base.drift.localAdded.length + base.drift.localRemoved.length} local edit(s)`)
  if (classified.kinds.includes('gone-upstream')) summaryBits.push('skill directory is gone upstream')

  for (const kind of classified.kinds) {
    addEvent({
      installationId: installation.id,
      repo: installation.repo,
      kind,
      fromRef: installation.ref,
      toRef: target.ref,
      summary: summaryBits.join('; ') || kind,
      severity: kind === 'conflict' || kind === 'gone-upstream' ? 'destructive' : kind === 'silent-change' || kind === 'version-regression' || kind === 'local-drift' || kind === 'content-change' ? 'attention' : 'info'
    })
  }
  if (classified.kinds.length === 0 && target.ref !== installation.ref && release.tag) {
    addEvent({
      installationId: installation.id,
      repo: installation.repo,
      kind: 'new-release',
      fromRef: installation.ref,
      toRef: target.ref,
      summary: `release ${release.tag} published, content unchanged`,
      severity: 'info'
    })
  }

  getDb()
    .prepare('UPDATE installations SET last_check_at = ?, last_state = ?, last_remote_ref = ? WHERE id = ?')
    .run(new Date().toISOString(), classified.state, target.ref, installation.id)

  // Auto-update is a policy the user chose, and it still refuses three things: local edits, a gate
  // that would need a human, and a major version jump when the policy only asks for minor ones.
  const auto = installation.policy_auto
  const driftFiles = base.drift.localChanged.length + base.drift.localAdded.length + base.drift.localRemoved.length
  const gateNeeded =
    diff.changed + diff.added + diff.removed + diff.moved > 20 || (base.localVersion && base.remoteVersion && !semverCompatible(base.localVersion, base.remoteVersion))
  const wanted =
    auto !== 'off' &&
    classified.state === 'behind' &&
    driftFiles === 0 &&
    classified.kinds.includes('content-change') &&
    !classified.kinds.includes('silent-change') &&
    !classified.kinds.includes('version-regression') &&
    !gateNeeded &&
    (auto === 'apply-any' || (auto === 'apply-minor' && (!base.localVersion || !base.remoteVersion || semverCompatible(base.localVersion, base.remoteVersion))))
  if (wanted) {
    const applied = await applyUpdate({ installationId: installation.id })
    if ('error' in applied) {
      addEvent({
        installationId: installation.id,
        repo: installation.repo,
        kind: 'auto-update-refused',
        toRef: target.ref,
        summary: `automatic update refused: ${applied.error}`,
        severity: 'attention'
      })
    } else {
      addEvent({
        installationId: installation.id,
        repo: installation.repo,
        kind: 'auto-updated',
        fromRef: installation.ref,
        toRef: applied.ref,
        summary: `updated automatically to ${applied.version ?? applied.ref.slice(0, 8)}`,
        severity: 'info'
      })
      return { ...base, diff, state: 'up-to-date', kinds: ['auto-updated'] }
    }
  }

  return { ...base, diff, state: classified.state, kinds: classified.kinds }
}

export async function runCheck(input: { repo?: string; installationId?: number; all?: boolean }): Promise<CheckSummary> {
  ensureMonitorTables()
  lastRun.requests = 0
  lastRun.conditional = 0
  const all = listInstallations()
  const selected = input.installationId
    ? all.filter((row) => row.id === input.installationId)
    : input.repo
      ? all.filter((row) => row.repo === input.repo)
      : all

  const byRepo: CheckSummary['byRepo'] = {}
  const cache = new Map<string, TreeResult>()
  let events = 0
  const outcomes: CheckOutcome[] = []

  for (const installation of selected) {
    let tree = cache.get(`${installation.repo}@${installation.policy_channel}`)
    const outcome = await checkInstallation(installation)
    outcomes.push(outcome)
    if (!byRepo[installation.repo]) {
      const treeAtTarget = await fetchTree(installation.repo, outcome.target.ref)
      tree = treeAtTarget
      cache.set(`${installation.repo}@${installation.policy_channel}`, treeAtTarget)
      const installed = new Set(all.filter((row) => row.repo === installation.repo).map((row) => row.remote_path))
      const skillDirs = new Set<string>()
      for (const file of tree.files) {
        const match = file.path.match(/^([^/]+\/[^/]+)\/SKILL\.md$/) ?? file.path.match(/^([^/]+)\/SKILL\.md$/)
        if (match) skillDirs.add(match[1])
      }
      const newSkills = [...skillDirs].filter((dir) => !installed.has(dir))
      byRepo[installation.repo] = { meta: outcome.meta, target: outcome.target.ref, newSkills }
      for (const dir of newSkills) {
        if (addEvent({
          installationId: null,
          repo: installation.repo,
          kind: 'new-skill',
          toRef: outcome.target.ref,
          summary: `${dir} exists upstream and is not installed`,
          severity: 'info'
        })) events += 1
      }
      if (outcome.meta.archived) {
        if (addEvent({
          installationId: null,
          repo: installation.repo,
          kind: 'archived',
          summary: 'repository archived upstream; checks continue',
          severity: 'info'
        })) events += 1
      }
    }
    events += outcome.kinds.length
  }

  return {
    checkedAt: new Date().toISOString(),
    requests: lastRun.requests,
    conditional: lastRun.conditional,
    rateLimit: { ...rateLimit },
    outcomes,
    byRepo,
    events
  }
}

/* ---------------------------------- blobs ---------------------------------- */

export async function fetchBlob(repo: string, blobSha: string): Promise<string | null> {
  const response = await api(`https://api.github.com/repos/${repo}/git/blobs/${blobSha}`)
  if (!response.ok) return null
  const data = (await response.json()) as { content?: string; encoding?: string; size?: number }
  if (!data.content) return null
  if (data.encoding === 'base64') return Buffer.from(data.content, 'base64').toString('utf8')
  return data.content
}

export async function fetchBlobBuffer(repo: string, blobSha: string): Promise<Buffer | null> {
  const response = await api(`https://api.github.com/repos/${repo}/git/blobs/${blobSha}`)
  if (!response.ok) return null
  const data = (await response.json()) as { content?: string; encoding?: string }
  if (!data.content) return null
  return data.encoding === 'base64' ? Buffer.from(data.content, 'base64') : Buffer.from(data.content, 'utf8')
}

/* ---------------------------------- diffing -------------------------------- */

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.bat', '.rb', '.go',
  '.rs', '.java', '.c', '.h', '.cpp', '.css', '.html', '.xml', '.csv', '.sql', '.env', '.gitignore'
])

const DIFF_CAP = 384 * 1024

export function looksText(filePath: string, sample: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return true
  if (!sample.length) return true
  let control = 0
  for (const byte of sample) if (byte === 0 || (byte < 9 && byte !== 0)) control += 1
  return control / sample.length < 0.02
}

function normaliseEndings(text: string): { text: string; changed: boolean } {
  const withoutCrlf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return { text: withoutCrlf, changed: withoutCrlf !== text }
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  left: number | null
  right: number | null
  text: string
}

/**
 * A line diff with numbers on both sides. Line endings are normalised first, because a repository
 * checked out on Windows would otherwise show every line as changed.
 */
export function lineDiff(before: string, after: string): { lines: DiffLine[]; additions: number; deletions: number; normalised: boolean } {
  const a = normaliseEndings(before)
  const b = normaliseEndings(after)
  const left = a.text.split('\n')
  const right = b.text.split('\n')
  const n = left.length
  const m = right.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  let additions = 0
  let deletions = 0
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      lines.push({ kind: 'same', left: i + 1, right: j + 1, text: left[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: 'del', left: i + 1, right: null, text: left[i] })
      deletions += 1
      i += 1
    } else {
      lines.push({ kind: 'add', left: null, right: j + 1, text: right[j] })
      additions += 1
      j += 1
    }
  }
  while (i < n) {
    lines.push({ kind: 'del', left: i + 1, right: null, text: left[i] })
    deletions += 1
    i += 1
  }
  while (j < m) {
    lines.push({ kind: 'add', left: null, right: j + 1, text: right[j] })
    additions += 1
    j += 1
  }
  return { lines, additions, deletions, normalised: a.changed || b.changed }
}

export interface FileDiff {
  path: string
  status: FileStatus
  binary: boolean
  tooLarge: boolean
  normalised: boolean
  additions: number
  deletions: number
  lines: DiffLine[]
  installedBytes: number | null
  remoteBytes: number | null
  installedBlob: string | null
  remoteBlob: string | null
  note?: string
}

export async function fileDiff(installation: InstallationRow, diffFile: DiffFile, source: 'remote' | 'local' = 'remote'): Promise<FileDiff> {
  const base: FileDiff = {
    path: diffFile.path,
    status: diffFile.status,
    binary: false,
    tooLarge: false,
    normalised: false,
    additions: 0,
    deletions: 0,
    lines: [],
    installedBytes: diffFile.installedBytes,
    remoteBytes: diffFile.remoteBytes,
    installedBlob: diffFile.installedBlob,
    remoteBlob: diffFile.remoteBlob
  }
  const useLocal = source === 'local'
  let before: Buffer | null = null
  let after: Buffer | null = null

  if (diffFile.installedBlob) {
    if (useLocal) {
      const localPath = path.join(installation.library_path, diffFile.path)
      before = fs.existsSync(localPath) ? fs.readFileSync(localPath) : null
    } else {
      before = await fetchBlobBuffer(installation.repo, diffFile.installedBlob)
    }
  }
  if (diffFile.remoteBlob) after = await fetchBlobBuffer(installation.repo, diffFile.remoteBlob)

  if (!before && diffFile.status !== 'added') base.note = 'installed content unavailable'
  if (!after && diffFile.status !== 'removed') base.note = 'remote content unavailable'

  const sizes = [before?.length ?? 0, after?.length ?? 0]
  if (Math.max(...sizes) > DIFF_CAP) {
    return { ...base, tooLarge: true, note: 'too large to diff' }
  }
  if (!looksText(diffFile.path, before ?? after ?? Buffer.alloc(0))) {
    return { ...base, binary: true, note: 'binary, size and hash only' }
  }
  const result = lineDiff(before?.toString('utf8') ?? '', after?.toString('utf8') ?? '')
  return {
    ...base,
    lines: result.lines,
    additions: result.additions,
    deletions: result.deletions,
    normalised: result.normalised,
    note: base.note
  }
}

/* ---------------------------------- the plan -------------------------------- */

export interface UpdatePlan {
  planId: string
  installationId: number
  fromRef: string
  toRef: string
  targetKind: string
  files: DiffFile[]
  fileCount: number
  additions: number
  deletions: number
  percent: number
  versionFrom: string | null
  versionTo: string | null
  overflow: boolean
  refusals: string[]
  gate: { required: boolean; reasons: string[] }
  drift: DriftReport
  localChoiceRequired: boolean
  generatedAt: string
  expiresAt: string
}

const plans = new Map<string, UpdatePlan & { summary: string }>()

function semverCompatible(from: string | null, to: string | null): boolean {
  const a = semverParts(from)
  const b = semverParts(to)
  if (!a || !b) return false
  return b[0] === a[0]
}

export async function planUpdate(installationId: number): Promise<UpdatePlan | { error: string; detail?: unknown }> {
  const installation = installationById(installationId)
  if (!installation) return { error: 'installation-not-found', detail: { installationId } }
  if (installation.pin_ref) return { error: 'pinned', detail: { ref: installation.pin_ref } }

  const meta = await repoMeta(installation.repo)
  if (meta.unreachable) return { error: 'unreachable', detail: meta.error }
  const release = await latestRelease(installation.repo)
  const target = await targetFor(installation, meta, release)
  const tree = await fetchTree(installation.repo, target.ref, false)
  if (tree.error) return { error: 'tree-unavailable', detail: tree.error }
  const remoteFiles = subtree(tree.files, installation.remote_path)
  if (!remoteFiles.length) return { error: 'gone-upstream', detail: { path: installation.remote_path } }

  const diff = packageDiff(installation, remoteFiles)
  const skillEntry = remoteFiles.find((file) => file.path === 'SKILL.md')
  const versionTo = skillEntry ? frontmatterVersion((await fetchBlob(installation.repo, skillEntry.blob)) ?? '') : null
  const drift = localDrift(installation)

  // Line counts need content, and only for text files under the cap: that is the price of gating on
  // lines rather than on file count alone.
  let additions = 0
  let deletions = 0
  for (const file of diff.files.filter((entry) => entry.status === 'changed')) {
    if (additions + deletions > 4000) break
    const detail = await fileDiff(installation, file)
    if (detail.binary || detail.tooLarge) continue
    additions += detail.additions
    deletions += detail.deletions
  }

  const driftFiles = drift.localChanged.length + drift.localAdded.length + drift.localRemoved.length
  const reasons: string[] = []
  if (diff.changed + diff.added + diff.removed + diff.moved > 20) reasons.push('more than 20 files changed')
  if (additions + deletions > 400) reasons.push('more than 400 lines changed')
  if (installation.version && versionTo && !semverCompatible(installation.version, versionTo)) {
    reasons.push(`version ${installation.version} → ${versionTo} is not backwards-compatible`)
  }

  const planId = crypto.randomUUID()
  const plan: UpdatePlan = {
    planId,
    installationId,
    fromRef: installation.ref,
    toRef: target.ref,
    targetKind: target.kind,
    files: diff.files.filter((file) => file.status !== 'same'),
    fileCount: diff.changed + diff.added + diff.removed + diff.moved,
    additions,
    deletions,
    percent: diff.percent,
    versionFrom: installation.version,
    versionTo,
    overflow: tree.truncated,
    refusals: [],
    gate: { required: reasons.length > 0, reasons },
    drift,
    localChoiceRequired: driftFiles > 0,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
  }
  plans.set(planId, { ...plan, summary: `${diff.changed + diff.added + diff.removed + diff.moved} files` })
  return plan
}

/* --------------------------------- the update ------------------------------ */

export interface UpdateResult {
  updated: boolean
  ref: string
  files: number
  trashed: string | null
  journal: number
  previousVersion: string | null
  version: string | null
}

function trashPackage(dir: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(DATA_DIR, 'trash', `${label}-${stamp}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(dir, target, { recursive: true, force: true })
  // The baseline travels with the bytes: a restore that re-derived the baseline from the restored
  // copy would report "no local edits" for a file the user had edited.
  const installId = getDb().prepare('SELECT id FROM installations WHERE library_path = ?').get(dir) as { id?: number } | undefined
  if (installId?.id) {
    const rows = getDb()
      .prepare('SELECT path, blob_sha, bytes, hash FROM installation_files WHERE installation_id = ?')
      .all(installId.id) as Array<{ path: string; blob_sha: string; bytes: number; hash: string }>
    try {
      fs.writeFileSync(path.join(target, '..', `${path.basename(target)}.baseline.json`), JSON.stringify(rows, null, 1))
    } catch {
      /* the copy on disk still counts even if the baseline note cannot be written */
    }
  }
  // The trash table belongs to the archive feature and carries a fixed expiry, so the copy is
  // recorded there with the same thirty-day window rather than in a table of its own.
  const now = new Date()
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  try {
    getDb()
      .prepare(
        `INSERT INTO trash (skill_path, name, root_path, scope, moved_to, at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(dir, path.basename(dir), path.dirname(dir), 'library', target, now.toISOString(), expires.toISOString())
  } catch {
    // a missing trash table must not cost the copy that is already on disk
  }
  return target
}

export async function applyUpdate(input: {
  installationId: number
  planId?: string
  choice?: 'refuse' | 'take-upstream'
}): Promise<UpdateResult | { error: string; detail?: unknown }> {
  const installation = installationById(input.installationId)
  if (!installation) return { error: 'installation-not-found' }
  if (installation.pin_ref) return { error: 'pinned' }

  const plan = input.planId ? plans.get(input.planId) : undefined
  if (input.planId && !plan) return { error: 'plan-not-found', detail: 'plans expire after thirty minutes' }
  if (plan && plan.installationId !== installation.id) return { error: 'plan-mismatch' }

  const drift = localDrift(installation)
  const driftFiles = drift.localChanged.length + drift.localAdded.length + drift.localRemoved.length
  // A local edit is never discarded on the strength of a missing flag.
  if (driftFiles > 0 && input.choice !== 'take-upstream') {
    return {
      error: 'local-edits',
      detail: {
        files: [...drift.localChanged, ...drift.localAdded, ...drift.localRemoved],
        options: ['take-upstream'],
        note: 'the local copy is in the trash, recoverable'
      }
    }
  }

  const meta = await repoMeta(installation.repo)
  if (meta.unreachable) return { error: 'unreachable', detail: meta.error }
  const release = await latestRelease(installation.repo)
  const target = plan ? { ref: plan.toRef, kind: plan.targetKind } : await targetFor(installation, meta, release)
  const tree = await fetchTree(installation.repo, target.ref, false)
  if (tree.error) return { error: 'tree-unavailable', detail: tree.error }
  const remoteFiles = subtree(tree.files, installation.remote_path)
  if (!remoteFiles.length) return { error: 'gone-upstream' }

  const trashed = driftFiles > 0 || plan?.fileCount ? trashPackage(installation.library_path, installation.name) : null

  // Write exactly what the tree says exists now, and remove what upstream removed.
  const keep = new Set(remoteFiles.map((file) => file.path))
  for (const local of walkFiles(installation.library_path)) {
    if (!keep.has(local.path)) fs.rmSync(local.full, { force: true })
  }
  let written = 0
  for (const file of remoteFiles) {
    const content = await fetchBlobBuffer(installation.repo, file.blob)
    if (!content) continue
    const targetPath = path.join(installation.library_path, file.path)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, content)
    written += 1
  }

  const previousVersion = installation.version
  const id = recordInstallation({
    repo: installation.repo,
    remotePath: installation.remote_path,
    ref: target.ref,
    refKind: 'commit',
    tag: release.tag,
    libraryPath: installation.library_path,
    channel: installation.policy_channel
  })
  const updated = installationById(id)!
  getDb()
    .prepare("INSERT INTO journal (action, at, payload) VALUES ('monitor-update', ?, ?)")
    .run(new Date().toISOString(), JSON.stringify({ installationId: id, from: installation.ref, to: target.ref, trashed, files: written }))

  return {
    updated: true,
    ref: target.ref,
    files: written,
    trashed,
    journal: id,
    previousVersion,
    version: updated.version
  }
}

export function rollbackInstallation(installationId: number, trashPath: string): { restored: boolean; error?: string } {
  const installation = installationById(installationId)
  if (!installation) return { restored: false, error: 'installation-not-found' }
  if (!fs.existsSync(trashPath)) return { restored: false, error: 'trash missing' }
  fs.rmSync(installation.library_path, { recursive: true, force: true })
  fs.cpSync(trashPath, installation.library_path, { recursive: true, force: true })
  let id = installation.id
  const baselineFile = path.join(path.dirname(trashPath), `${path.basename(trashPath)}.baseline.json`)
  if (fs.existsSync(baselineFile)) {
    const rows = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as Array<{ path: string; blob_sha: string; bytes: number; hash: string }>
    getDb().prepare('DELETE FROM installation_files WHERE installation_id = ?').run(installation.id)
    const insert = getDb().prepare(
      'INSERT INTO installation_files (installation_id, path, blob_sha, bytes, hash) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of rows) insert.run(installation.id, row.path, row.blob_sha, row.bytes, row.hash)
    getDb()
      .prepare('UPDATE installations SET last_state = ?, last_check_at = ? WHERE id = ?')
      .run('local-drift', new Date().toISOString(), installation.id)
  } else {
    id = recordInstallation({
      repo: installation.repo,
      remotePath: installation.remote_path,
      ref: installation.ref,
      refKind: installation.ref_kind as 'commit' | 'tag' | 'branch',
      tag: installation.tag,
      libraryPath: installation.library_path,
      channel: installation.policy_channel
    })
  }
  getDb()
    .prepare("INSERT INTO journal (action, at, payload) VALUES ('monitor-rollback', ?, ?)")
    .run(new Date().toISOString(), JSON.stringify({ installationId: id, from: trashPath }))
  return { restored: true }
}

/* ------------------------------ pin, policy, misc --------------------------- */

export function setPin(id: number, ref: string | null, note?: string): boolean {
  ensureMonitorTables()
  const info = getDb().prepare('UPDATE installations SET pin_ref = ?, pin_note = ? WHERE id = ?').run(ref, note ?? null, id)
  return Number(info.changes) > 0
}

export function setPolicy(id: number, channel: Channel, auto: AutoPolicy): boolean {
  ensureMonitorTables()
  const info = getDb()
    .prepare('UPDATE installations SET policy_channel = ?, policy_auto = ? WHERE id = ?')
    .run(channel, auto, id)
  return Number(info.changes) > 0
}

export interface MonitorInstallationView extends InstallationRow {
  drift: DriftReport
  hasLocalEdits: boolean
}

export interface MonitorRepoView {
  repo: string
  canonical: string
  archived: boolean
  unreachable: boolean
  installations: MonitorInstallationView[]
  states: Record<string, number>
  changed: number
  watched: boolean
}

/** The list the screen renders: one row per repository, installations nested underneath. */
export function monitorOverview(): { repos: MonitorRepoView[]; events: MonitorEvent[]; rateLimit: RateLimit } {
  ensureMonitorTables()
  const rows = listInstallations()
  const byRepo = new Map<string, MonitorInstallationView[]>()
  for (const row of rows) {
    const drift = localDrift(row)
    const view: MonitorInstallationView = {
      ...row,
      drift,
      hasLocalEdits: drift.localChanged.length + drift.localAdded.length + drift.localRemoved.length > 0
    }
    byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), view])
  }
  // A watched repository with nothing installed still belongs on the screen, but the sources table
  // is owned by another module and may not exist yet in a fresh database.
  let watched: Array<{ repo: string }> = []
  try {
    watched = getDb().prepare('SELECT repo FROM sources').all() as unknown as Array<{ repo: string }>
  } catch {
    watched = []
  }
  for (const entry of watched) if (!byRepo.has(entry.repo)) byRepo.set(entry.repo, [])

  const repos: MonitorRepoView[] = [...byRepo.entries()]
    .map(([repo, installations]) => {
      const states: Record<string, number> = {}
      for (const row of installations) {
        const state = row.last_state ?? 'unknown'
        states[state] = (states[state] ?? 0) + 1
      }
      const changed = installations.filter((row) => row.last_state && row.last_state !== 'up-to-date').length
      return {
        repo,
        canonical: repo,
        archived: false,
        unreachable: installations.some((row) => row.last_state === 'unreachable'),
        installations,
        states,
        changed,
        watched: true
      }
    })
    .sort((a, b) => a.repo.localeCompare(b.repo))

  return { repos, events: listEvents(false), rateLimit: { ...rateLimit } }
}

/* --------------------------------- backfill -------------------------------- */

export function libraryRoot(): string {
  return path.join(DATA_DIR, '..', 'library')
}

interface ProvenanceManifest {
  repo?: string
  path?: string
  ref?: string
  name?: string
}

function manifestOf(dir: string): ProvenanceManifest | null {
  const candidates = ['.skill-academy.json', '.provenance.json']
  for (const name of candidates) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ProvenanceManifest
    } catch {
      return null
    }
  }
  return null
}

/** The nearest `.git` above a directory, so a library copy inside a clone still knows its origin. */
function gitOriginOf(dir: string): { repo: string; remotePath: string } | null {
  let current = path.resolve(dir)
  for (let depth = 0; depth < 6; depth += 1) {
    const config = path.join(current, '.git', 'config')
    if (fs.existsSync(config)) {
      try {
        const url = /url\s*=\s*(.+)/.exec(fs.readFileSync(config, 'utf8'))?.[1]?.trim()
        if (!url) return null
        const cleaned = url.replace(/\.git$/i, '')
        const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(cleaned)
        const repo = (scp ? scp[1] : cleaned.replace(/^[a-z+]+:\/\/[^/]+\//i, '')).replace(/^\/+/, '')
        const remotePath = path.relative(current, path.resolve(dir)).split(path.sep).join('/')
        if (/^[\w.-]+\/[\w.-]+$/.test(repo) && remotePath && !remotePath.startsWith('..')) {
          return { repo, remotePath }
        }
        return null
      } catch {
        return null
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

export interface UnrecordedSkill {
  name: string
  path: string
  repo: string | null
  remotePath: string | null
  ref: string | null
  reason: string
}

/**
 * A copy installed before the monitor existed has no baseline. It is listed with whatever origin can
 * be proven, because a baseline invented from current bytes can never tell the user what changed.
 */
export function unrecordedSkills(): UnrecordedSkill[] {
  ensureMonitorTables()
  const root = libraryRoot()
  if (!fs.existsSync(root)) return []
  const known = new Set(listInstallations().map((row) => path.resolve(row.library_path)))
  const out: UnrecordedSkill[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (known.has(path.resolve(dir))) continue
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue
    const manifest = manifestOf(dir)
    const git = manifest?.repo ? null : gitOriginOf(dir)
    const repo = manifest?.repo ?? git?.repo ?? null
    const remotePath = manifest?.path ?? git?.remotePath ?? null
    out.push({
      name: entry.name,
      path: dir,
      repo,
      remotePath,
      ref: manifest?.ref ?? null,
      reason: repo && remotePath ? 'origin known, no baseline recorded' : repo ? 'repository known, path unknown' : 'no origin recorded'
    })
  }
  return out
}

/**
 * Adopt a library copy into the monitor. Without a ref the baseline cannot claim to be upstream
 * truth, so the record says so instead of pretending the current bytes are the original ones.
 */
export function adoptLibrarySkill(input: { path: string; repo?: string; remotePath?: string; ref?: string }): { id: number } | { error: string; detail?: unknown } {
  ensureMonitorTables()
  const dir = path.resolve(input.path)
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return { error: 'not-a-skill', detail: dir }
  const manifest = manifestOf(dir)
  const git = gitOriginOf(dir)
  const repo = input.repo ?? manifest?.repo ?? git?.repo
  const remotePath = input.remotePath ?? manifest?.path ?? git?.remotePath
  if (!repo || !remotePath) return { error: 'origin-unknown', detail: 'a repository and the path inside it are required' }
  const ref = input.ref ?? manifest?.ref ?? null
  const id = recordInstallation({
    repo,
    remotePath,
    ref: ref ?? 'unknown',
    refKind: ref ? 'commit' : 'branch',
    libraryPath: dir
  })
  if (!ref) {
    getDb().prepare('UPDATE installations SET baseline_lost = 1 WHERE id = ?').run(id)
  }
  return { id }
}

export interface InstallCandidate {
  repo: string
  remotePath: string
  ref: string
}

export function exportMonitor(): string {
  ensureMonitorTables()
  const rows = listInstallations()
  const lines: string[] = []
  for (const row of rows) {
    lines.push(JSON.stringify({ kind: 'installation', ...row }))
    for (const file of baselineFiles(row.id)) lines.push(JSON.stringify({ ...file, kind: 'file', installationId: row.id }))
  }
  for (const event of listEvents(true)) lines.push(JSON.stringify({ ...event, kind: 'event' }))
  return lines.join('\n')
}
