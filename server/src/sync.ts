import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, LIBRARY_DIR } from './config'
import { getDb } from './db'
import { restoreFromLock } from './lockrestore'
import { defaultLockPath, writeLock } from './lockdoc'

export interface SyncConfig {
  repo: string
  branch: string
}

export interface SecretFinding {
  file: string
  line: number
  kind: string
}

export interface SyncConflict {
  file: string
  /** Where the local copy is, relative to the sync tree, for showing. */
  keptLocalAs: string
  /** The same file as an absolute path, for a caller that wants to open it. */
  keptLocalPath: string
}

const SYNC_DIR = path.join(DATA_DIR, 'sync')
const TEXT_LIMIT = 1_000_000

/** Where a machine keeps its copy of the shared repository. */
export function syncDirectory(): string {
  return SYNC_DIR
}

export function readSyncConfig(): SyncConfig {
  const rows = getDb()
    .prepare("SELECT key, value FROM meta WHERE key IN ('sync_repo', 'sync_branch')")
    .all() as Array<{ key: string; value: string }>
  const found = new Map(rows.map((row) => [row.key, row.value]))
  return { repo: found.get('sync_repo') ?? '', branch: found.get('sync_branch') ?? 'main' }
}

export function setSyncConfig(repo: string, branch: string): SyncConfig {
  const db = getDb()
  const write = (key: string, value: string): void => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }
  write('sync_repo', repo)
  write('sync_branch', branch || 'main')
  return readSyncConfig()
}

/**
 * Key-shaped strings, checked before anything is committed. A skill can carry a credential by
 * accident, and a repository is forever, so the push stops rather than the mistake spreading.
 */
const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  // Written as string sources with explicit neighbours rather than word boundaries: the patterns
  // are readable, and nothing here depends on how a backslash survives an editor.
  { kind: 'openai-style key', pattern: new RegExp('(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}') },
  { kind: 'anthropic key', pattern: new RegExp('(^|[^A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}') },
  { kind: 'github token', pattern: new RegExp('(^|[^A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})') },
  { kind: 'google api key', pattern: new RegExp('(^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}') },
  { kind: 'slack token', pattern: new RegExp('(^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}') },
  { kind: 'aws access key', pattern: new RegExp('(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}') },
  { kind: 'private key', pattern: new RegExp('-----BEGIN [A-Z ]*PRIVATE KEY-----') },
  {
    kind: 'assigned secret',
    pattern: new RegExp('(api[_-]?key|secret|token|password)[^A-Za-z0-9]{0,3}[:=][^A-Za-z0-9]{0,3}[A-Za-z0-9_./+=-]{24,}', 'i')
  }
]

/** Reads every text file under a folder and reports any line that looks like a credential. */
export function scanForSecrets(root: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.snapshots') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      if (size > TEXT_LIMIT) continue
      let text: string
      try {
        text = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (text.includes('\u0000')) continue
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        for (const { kind, pattern } of SECRET_PATTERNS) {
          if (pattern.test(lines[index])) {
            findings.push({ file: path.relative(root, full).split(path.sep).join('/'), line: index + 1, kind })
            break
          }
        }
      }
    }
  }
  walk(root)
  return findings
}

function git(args: string[], cwd = SYNC_DIR): { ok: boolean; out: string; err: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 })
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() || (result.error?.message ?? '') }
}

/** A checkout that is ready to receive a copy of what this machine owns. */
export function prepareSyncTree(config: SyncConfig): { ok: boolean; error?: string; created?: boolean } {
  const repo = config.repo.trim()
  if (!repo) return { ok: false, error: 'no-repository' }
  const isRepo = fs.existsSync(path.join(SYNC_DIR, '.git'))
  let created = false
  if (!isRepo) {
    fs.mkdirSync(SYNC_DIR, { recursive: true })
    const init = git(['init', '-q', '-b', config.branch || 'main'])
    if (!init.ok) return { ok: false, error: `git init failed: ${init.err}` }
    created = true
  }
  // A skill's hash is computed over its bytes, so git must not rewrite line endings on the way in
  // or out; `* -text` says so per file, and core.autocrlf covers the checkout itself.
  const attributes = path.join(SYNC_DIR, '.gitattributes')
  if (!fs.existsSync(attributes)) fs.writeFileSync(attributes, '* -text\n', 'utf8')
  git(['config', 'core.autocrlf', 'false'])
  const remotes = git(['remote'])
  const hasOrigin = remotes.out.split(/\r?\n/).includes('origin')
  if (!hasOrigin) {
    const add = git(['remote', 'add', 'origin', repo])
    if (!add.ok) return { ok: false, error: `git remote failed: ${add.err}` }
  } else {
    const current = git(['remote', 'get-url', 'origin']).out
    if (current !== repo) git(['remote', 'set-url', 'origin', repo])
  }
  return { ok: true, created }
}

/** Copies what this machine owns into the sync tree. Snapshots and the database stay behind. */
export function stageTree(): { files: number } {
  let files = 0
  const copyInto = (from: string, to: string): void => {
    if (!fs.existsSync(from)) return
    fs.rmSync(to, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.snapshots`) && !source.endsWith('.skill-academy.json')
    })
    const count = (dir: string): number => {
      let total = 0
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) total += count(path.join(dir, entry.name))
        else total += 1
      }
      return total
    }
    files += count(to)
  }
  copyInto(LIBRARY_DIR, path.join(SYNC_DIR, 'library'))
  copyInto(path.join(DATA_DIR, 'drafts'), path.join(SYNC_DIR, 'drafts'))
  const lock = path.join(DATA_DIR, 'skill-academy.lock.json')
  if (fs.existsSync(lock)) {
    fs.copyFileSync(lock, path.join(SYNC_DIR, 'skill-academy.lock.json'))
    files += 1
  }
  return { files }
}

export function pushSync(config: SyncConfig): {
  ok: boolean
  error?: string
  findings?: SecretFinding[]
  commit?: string
  pushed?: boolean
  files?: number
} {
  const prepared = prepareSyncTree(config)
  if (!prepared.ok) return { ok: false, error: prepared.error }
  // The lock is written first: a push that carries packages but not the document describing them is
  // a backup of files, not of a library.
  writeLock(defaultLockPath())
  const staged = stageTree()
  // The scan runs over what would be committed, before the commit exists.
  const findings = scanForSecrets(SYNC_DIR)
  if (findings.length) return { ok: false, error: 'secrets-found', findings, files: staged.files }

  git(['add', '-A'])
  const status = git(['status', '--porcelain'])
  if (!status.out) return { ok: true, commit: git(['rev-parse', '--short', 'HEAD']).out, pushed: false, files: 0 }
  const message = `skill-academy: ${staged.files} files from ${process.env.COMPUTERNAME ?? 'this machine'}`
  const commit = git(['-c', 'user.name=skill-academy', '-c', 'user.email=sync@skill-academy.local', 'commit', '-q', '-m', message])
  if (!commit.ok) return { ok: false, error: `commit failed: ${commit.err}` }
  const push = git(['push', '-q', 'origin', `HEAD:${config.branch || 'main'}`])
  if (!push.ok) return { ok: false, error: `push failed: ${push.err}`, files: staged.files }
  return { ok: true, commit: git(['rev-parse', '--short', 'HEAD']).out, pushed: true, files: staged.files }
}

/**
 * Pulls the shared repository and merges it into what this machine has.
 *
 * A file changed on both sides is a conflict, and a conflict here loses nothing: this machine's copy
 * is kept beside the file under a stamp before the shared version is written, and the pair is
 * reported so a person can choose. Nothing resolves itself.
 */
export function pullSync(config: SyncConfig): {
  ok: boolean
  error?: string
  restored?: number
  conflicts?: SyncConflict[]
  commit?: string
} {
  const prepared = prepareSyncTree(config)
  if (!prepared.ok) return { ok: false, error: prepared.error }

  if (prepared.created) {
    // A machine with no copy of the shared repository has nothing to merge: it takes the branch as
    // it is. Staging first would overwrite what it just fetched with its own empty library.
    const fetch = git(['fetch', 'origin', config.branch || 'main'])
    if (!fetch.ok) return { ok: false, error: `nothing to pull: ${fetch.err}` }
    const checkout = git(['checkout', '-q', '-f', '-B', config.branch || 'main', 'origin/' + (config.branch || 'main')])
    if (!checkout.ok) return { ok: false, error: `checkout failed: ${checkout.err}` }
    return { ok: true, restored: applyTree(), conflicts: [], commit: git(['rev-parse', '--short', 'HEAD']).out }
  } else {
    const fetch = git(['fetch', '-q', 'origin', config.branch || 'main'])
    if (!fetch.ok) return { ok: false, error: `fetch failed: ${fetch.err}` }
    const behind = git(['rev-list', '--count', `HEAD..origin/${config.branch || 'main'}`]).out
    if (behind === '0') return { ok: true, restored: 0, conflicts: [] }
  }

  // What this machine owns is staged first, so a change made here is a change git can see.
  stageTree()

  const base = `origin/${config.branch || 'main'}`
  const incoming = git(['diff', '--name-only', `HEAD..${base}`]).out.split(/\r?\n/).filter(Boolean)

  // A file that arrives and was also changed here is a conflict. The local copy is put beside the
  // file before the shared version lands, so neither side loses anything and a person can choose.
  const conflicts: SyncConflict[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const file of incoming) {
    const full = path.join(SYNC_DIR, file)
    if (!fs.existsSync(full)) continue
    const head = git(['show', `HEAD:${file}`])
    const local = fs.readFileSync(full, 'utf8')
    if (!head.ok) {
      // The file is new here: it is this machine's, and the shared one is new as well.
      const kept = `${full}.local-${stamp}`
      fs.writeFileSync(kept, local, 'utf8')
      conflicts.push({
        file,
        keptLocalAs: path.relative(SYNC_DIR, kept).split(path.sep).join('/'),
        keptLocalPath: kept
      })
      continue
    }
    if (head.out === local.trimEnd() || head.out === local) continue
    const kept = `${full}.local-${stamp}`
    fs.writeFileSync(kept, local, 'utf8')
    conflicts.push({
      file,
      keptLocalAs: path.relative(SYNC_DIR, kept).split(path.sep).join('/'),
      keptLocalPath: kept
    })
  }

  // The shared branch becomes the tree. Untracked files, including the copies just written, stay.
  const reset = git(['reset', '--hard', '-q', base])
  if (!reset.ok) return { ok: false, error: `could not take the shared branch: ${reset.err}`, conflicts }

  const restored = applyTree()
  return { ok: true, restored, conflicts, commit: git(['rev-parse', '--short', 'HEAD']).out }
}

/** Copies the sync tree back over the library and drafts, and re-indexes what changed. */
function applyTree(): number {
  let restored = 0
  const copyBack = (from: string, to: string): void => {
    if (!fs.existsSync(from)) return
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      fs.cpSync(source, target, { recursive: true, force: true })
      restored += 1
    }
  }
  copyBack(path.join(SYNC_DIR, 'library'), LIBRARY_DIR)
  copyBack(path.join(SYNC_DIR, 'drafts'), path.join(DATA_DIR, 'drafts'))

  // The shared lock comes with the tree, and it is what puts the skills back in the index and their
  // switches back where they were. A pull onto a fresh machine therefore restores the library, not
  // just the files.
  const sharedLock = path.join(SYNC_DIR, 'skill-academy.lock.json')
  if (fs.existsSync(sharedLock)) {
    const local = path.join(DATA_DIR, 'skill-academy.lock.json')
    fs.copyFileSync(sharedLock, local)
    const rebuilt = restoreFromLock(local, { apply: true })
    if ('error' in rebuilt) console.error('pull restored the files but not the index:', rebuilt.error)
  }
  return restored
}

export function syncStatus(): {
  config: SyncConfig
  initialized: boolean
  branch: string | null
  commit: string | null
  ahead: number | null
  behind: number | null
  clean: boolean | null
} {
  const config = readSyncConfig()
  const initialized = fs.existsSync(path.join(SYNC_DIR, '.git'))
  if (!initialized) {
    return { config, initialized: false, branch: null, commit: null, ahead: null, behind: null, clean: null }
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || null
  const commit = git(['rev-parse', '--short', 'HEAD']).out || null
  let ahead: number | null = null
  let behind: number | null = null
  if (git(['rev-parse', '--verify', `origin/${config.branch || 'main'}`]).ok) {
    ahead = Number(git(['rev-list', '--count', `origin/${config.branch || 'main'}..HEAD`]).out || 0)
    behind = Number(git(['rev-list', '--count', `HEAD..origin/${config.branch || 'main'}`]).out || 0)
  }
  return { config, initialized: true, branch, commit, ahead, behind, clean: git(['status', '--porcelain']).out === '' }
}
