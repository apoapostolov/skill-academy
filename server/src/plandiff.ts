import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * One package diff, used by every merge flow and by the editor.
 *
 * A merge dialog is only honest if the reader can see the finished skill before it exists, so this
 * module compares two states of a package — two directories, or a directory against proposed file
 * contents — and returns per-file lines plus a manifest for everything that is not prose.
 */

export type FileKind = 'prose' | 'template' | 'script' | 'asset' | 'other'
export type FileStatus = 'same' | 'changed' | 'added' | 'removed'

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
  /** Line numbers on each side, null where the line does not exist. */
  before: number | null
  after: number | null
}

export interface FileStats {
  added: number
  removed: number
  lines: number
}

export interface BinaryInfo {
  beforeBytes: number | null
  afterBytes: number | null
  /** A thumbnail is only carried for an added or replaced image, and only when asked for. */
  afterDataUrl?: string
  mime?: string
}

export interface FileEntry {
  path: string
  kind: FileKind
  status: FileStatus
  stats: FileStats
  lines: DiffLine[]
  binary?: BinaryInfo
  /** Large files are summarised rather than rendered. */
  truncated?: boolean
  note?: string
}

export interface PackageDiff {
  files: FileEntry[]
  totals: {
    files: number
    changed: number
    added: number
    removed: number
    same: number
    addedLines: number
    removedLines: number
    assets: number
    scripts: number
  }
  /** Paths that exist in only one side, kept for the manifest. */
  manifest: Array<{ path: string; kind: FileKind; status: FileStatus; bytes: number | null; beforeBytes: number | null }>
}

const MAX_RENDER_LINES = 4000
const MAX_LCS_LINES = 1200
const MAX_INLINE_IMAGE = 512 * 1024

export function kindOf(relative: string): FileKind {
  const normal = relative.split(path.sep).join('/')
  const ext = path.extname(normal).toLowerCase()
  if (normal === 'SKILL.md' || ext === '.md' || ext === '.mdx' || ext === '.txt') {
    return normal.startsWith('templates/') ? 'template' : 'prose'
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'].includes(ext)) return 'asset'
  if (['.sh', '.ps1', '.py', '.js', '.ts', '.mjs', '.cjs', '.bat', '.cmd', '.rb', '.go', '.rs'].includes(ext)) return 'script'
  return 'other'
}

function mimeOf(relative: string): string | undefined {
  const ext = path.extname(relative).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.svg') return 'image/svg+xml'
  return undefined
}

/** Every file in a package, relative to its root, with the content hash. */
export function snapshotPackage(dir: string | null): Map<string, { text: string | null; bytes: number; hash: string }> {
  const result = new Map<string, { text: string | null; bytes: number; hash: string }>()
  if (!dir || !existsSync(dir)) return result
  const walk = (base: string, relative: string): void => {
    for (const entry of readdirSync(path.join(base, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.skill-academy') continue
        walk(base, rel)
        continue
      }
      if (!entry.isFile()) continue
      const full = path.join(base, rel)
      const buffer = readFileSync(full)
      const kind = kindOf(rel)
      const text = kind === 'asset' ? null : buffer.toString('utf8')
      result.set(rel.split(path.sep).join('/'), {
        text,
        bytes: buffer.length,
        hash: createHash('sha256').update(buffer).digest('hex')
      })
    }
  }
  walk(dir, '')
  return result
}

function lcs(a: string[], b: string[]): DiffLine[] {
  // Common prefix and suffix first: a version bump at the top should not cost a full matrix.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  const lines: DiffLine[] = []
  for (let index = 0; index < start; index += 1) {
    lines.push({ kind: 'same', text: a[index], before: index + 1, after: index + 1 })
  }
  if (middleA.length > MAX_LCS_LINES || middleB.length > MAX_LCS_LINES) {
    for (let index = 0; index < middleA.length; index += 1) {
      lines.push({ kind: 'del', text: middleA[index], before: start + index + 1, after: null })
    }
    for (let index = 0; index < middleB.length; index += 1) {
      lines.push({ kind: 'add', text: middleB[index], before: null, after: start + index + 1 })
    }
    for (let index = endA; index < a.length; index += 1) {
      lines.push({ kind: 'same', text: a[index], before: index + 1, after: index + 1 - (endA - endB) })
    }
    return lines
  }
  const rows = middleA.length + 1
  const cols = middleB.length + 1
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = middleA.length - 1; i >= 0; i -= 1) {
    for (let j = middleB.length - 1; j >= 0; j -= 1) {
      table[i][j] = middleA[i] === middleB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < middleA.length && j < middleB.length) {
    if (middleA[i] === middleB[j]) {
      lines.push({ kind: 'same', text: middleA[i], before: start + i + 1, after: start + j + 1 })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: 'del', text: middleA[i], before: start + i + 1, after: null })
      i += 1
    } else {
      lines.push({ kind: 'add', text: middleB[j], before: null, after: start + j + 1 })
      j += 1
    }
  }
  while (i < middleA.length) {
    lines.push({ kind: 'del', text: middleA[i], before: start + i + 1, after: null })
    i += 1
  }
  while (j < middleB.length) {
    lines.push({ kind: 'add', text: middleB[j], before: null, after: start + j + 1 })
    j += 1
  }
  for (let index = endA; index < a.length; index += 1) {
    lines.push({ kind: 'same', text: a[index], before: index + 1, after: endB + (index - endA) + 1 })
  }
  return lines
}

function lineStats(lines: DiffLine[]): FileStats {
  return {
    added: lines.filter((line) => line.kind === 'add').length,
    removed: lines.filter((line) => line.kind === 'del').length,
    lines: lines.length
  }
}

export interface DiffOptions {
  /** Carry an inline thumbnail for added or replaced images (kept small on purpose). */
  images?: boolean
  /** Show unchanged lines around a change. */
  context?: number
}

/**
 * The frontmatter is a region of its own: a changed description is a real change to a skill, and a
 * reader should not have to find it inside a body diff.
 */
function frontmatterOf(text: string | null): { head: string[]; body: string[] } {
  if (!text) return { head: [], body: [] }
  const lines = text.split('\n')
  if (lines[0] !== '---') return { head: [], body: lines }
  const close = lines.indexOf('---', 1)
  if (close === -1) return { head: [], body: lines }
  return { head: lines.slice(0, close + 1), body: lines.slice(close + 1) }
}

export function diffPackages(
  beforeDir: string | null,
  after: { dir?: string | null; files?: Map<string, string | null> },
  options: DiffOptions = {}
): PackageDiff {
  const before = snapshotPackage(beforeDir)
  // A proposed state arrives as text; a directory arrives as bytes. One shape from here on.
  const afterFiles: Map<string, { text: string | null; bytes: number; hash: string }> = after.files
    ? new Map(
        [...after.files.entries()].map(([relative, text]) => [
          relative,
          {
            text,
            bytes: text === null ? 0 : Buffer.byteLength(text, 'utf8'),
            hash: text === null ? 'binary' : createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
          }
        ])
      )
    : snapshotPackage(after.dir ?? null)
  const paths = [...new Set([...before.keys(), ...afterFiles.keys()])].sort((a, b) => {
    if (a === 'SKILL.md') return -1
    if (b === 'SKILL.md') return 1
    return a.localeCompare(b)
  })

  const files: FileEntry[] = []
  const manifest: PackageDiff['manifest'] = []

  for (const relative of paths) {
    const was = before.get(relative)
    const now = afterFiles.get(relative)
    const kind = kindOf(relative)
    if (was && now && was.hash === now.hash) {
      files.push({ path: relative, kind, status: 'same', stats: { added: 0, removed: 0, lines: 0 }, lines: [] })
      continue
    }
    const status: FileStatus = !was ? 'added' : !now ? 'removed' : 'changed'

    if (kind === 'asset' || (was?.text === null && now?.text === null)) {
      const binary: BinaryInfo = {
        beforeBytes: was?.bytes ?? null,
        afterBytes: now?.bytes ?? null,
        mime: mimeOf(relative)
      }
      if (options.images && now && mimeOf(relative) && (now.bytes ?? 0) <= MAX_INLINE_IMAGE && after.dir) {
        const full = path.join(after.dir, relative)
        if (existsSync(full)) {
          binary.afterDataUrl = `data:${mimeOf(relative)};base64,${readFileSync(full).toString('base64')}`
        }
      }
      files.push({ path: relative, kind, status, stats: { added: 0, removed: 0, lines: 0 }, lines: [], binary })
      manifest.push({ path: relative, kind, status, bytes: now?.bytes ?? null, beforeBytes: was?.bytes ?? null })
      continue
    }

    const beforeText = was?.text ?? ''
    const afterText = now?.text ?? ''

    if (relative === 'SKILL.md') {
      const beforeParts = frontmatterOf(beforeText)
      const afterParts = frontmatterOf(afterText)
      if (beforeParts.head.join('\n') !== afterParts.head.join('\n')) {
        const headLines = lcs(beforeParts.head, afterParts.head)
        files.push({
          path: 'frontmatter',
          kind: 'prose',
          status,
          stats: lineStats(headLines),
          lines: headLines,
          note: 'the frontmatter of SKILL.md'
        })
      }
      const bodyLines = lcs(beforeParts.body, afterParts.body)
      if (bodyLines.some((line) => line.kind !== 'same')) {
        files.push({ path: relative, kind, status, stats: lineStats(bodyLines), lines: bodyLines })
        manifest.push({ path: relative, kind, status, bytes: now?.bytes ?? null, beforeBytes: was?.bytes ?? null })
      }
      continue
    }

    const beforeLines = beforeText.split('\n')
    const afterLines = afterText.split('\n')
    const lines = lcs(beforeLines, afterLines)
    const entry: FileEntry = {
      path: relative,
      kind,
      status,
      stats: lineStats(lines),
      lines: lines.length > MAX_RENDER_LINES ? lines.slice(0, MAX_RENDER_LINES) : lines,
      truncated: lines.length > MAX_RENDER_LINES,
      note: lines.length > MAX_RENDER_LINES ? `showing the first ${MAX_RENDER_LINES} lines of ${lines.length}` : undefined
    }
    files.push(entry)
    manifest.push({ path: relative, kind, status, bytes: now?.bytes ?? null, beforeBytes: was?.bytes ?? null })
  }

  const changed = files.filter((file) => file.status !== 'same')
  return {
    files: orderFiles(files),
    totals: {
      files: files.length,
      changed: changed.length,
      added: changed.filter((file) => file.status === 'added').length,
      removed: changed.filter((file) => file.status === 'removed').length,
      same: files.length - changed.length,
      addedLines: changed.reduce((sum, file) => sum + file.stats.added, 0),
      removedLines: changed.reduce((sum, file) => sum + file.stats.removed, 0),
      assets: files.filter((file) => file.kind === 'asset' && file.status !== 'same').length,
      scripts: files.filter((file) => file.kind === 'script' && file.status !== 'same').length
    },
    manifest
  }
}

/** SKILL.md, then frontmatter, then prose, then templates, then scripts, then assets. */
function orderFiles(files: FileEntry[]): FileEntry[] {
  const rank = (file: FileEntry): number => {
    if (file.path === 'SKILL.md') return 0
    if (file.path === 'frontmatter') return 1
    return ({ prose: 2, template: 3, script: 4, asset: 5, other: 6 } as const)[file.kind]
  }
  return files.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
}

/** Substantive lines of a body: no blanks, no headings, no frontmatter. */
export function substantiveLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

export function normaliseLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/^[-+*]\s*/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fileHashOf(dir: string, relative: string): string | null {
  const full = path.join(dir, relative)
  if (!existsSync(full) || !statSync(full).isFile()) return null
  return createHash('sha256').update(readFileSync(full)).digest('hex')
}
