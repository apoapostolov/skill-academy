import fs from 'node:fs'
import path from 'node:path'

export type PackageKind = 'reference' | 'script' | 'asset'

export interface PackageEntry {
  kind: PackageKind
  name: string
  relPath: string
  size: number
  ext: string
  /** For scripts: the leading comment block, which is the closest thing to a contract. */
  description?: string
}

export interface PackageTree {
  entries: PackageEntry[]
  counts: Record<PackageKind, number>
}

const SCRIPT_EXT = new Set([
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.lua', '.bat', '.cmd', '.php'
])
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.ini', '.jsonc'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.skill-academy', '__pycache__', '.venv', 'venv', 'dist', 'build', 'target'])
const SKIP_EXT = new Set(['.pyc', '.pyo', '.so', '.dll', '.exe', '.class', '.o', '.a'])
const MAX_DEPTH = 3
const MAX_ENTRIES = 400

/** Reads the leading comment block of a script: `#`, `//`, `--`, `;`, or a docstring. */
export function scriptDescription(text: string): string | undefined {
  const lines = text.split(/\r?\n/).slice(0, 60)
  const collected: string[] = []
  let started = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!started && (line.startsWith('#!') || line === '')) continue
    const comment = /^(#|\/\/|--|;)\s?(.*)$/.exec(line)
    if (comment) {
      started = true
      const body = comment[2].trim()
      if (body && !/^[-=*#]{3,}$/.test(body)) collected.push(body)
      continue
    }
    if (!started && (line.startsWith('"""') || line.startsWith("'''"))) {
      const quoted = line.slice(3)
      if (quoted && !quoted.startsWith('"')) collected.push(quoted.replace(/["']$/, ''))
      started = true
      continue
    }
    if (!started && line.startsWith('/*')) {
      started = true
      const body = line.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim()
      if (body) collected.push(body)
      continue
    }
    if (started) break
  }
  const description = collected.join(' ').replace(/\s+/g, ' ').trim()
  if (!description) return undefined
  return description.length > 240 ? `${description.slice(0, 237)}…` : description
}

const STANDARD_FOLDERS: Record<string, PackageKind> = {
  references: 'reference',
  reference: 'reference',
  docs: 'reference',
  scripts: 'script',
  assets: 'asset',
  images: 'asset',
  media: 'asset'
}

/** A folder is typed by what it holds: markdown first, then scripts, else assets. */
function folderKind(files: PackageEntry[]): PackageKind {
  if (files.some((file) => /\.(md|markdown)$/i.test(file.name))) return 'reference'
  if (files.some((file) => SCRIPT_EXT.has(file.ext.toLowerCase()))) return 'script'
  return 'asset'
}

function classify(relPath: string): PackageKind {
  const lower = relPath.toLowerCase()
  const ext = path.extname(lower)
  const segments = lower.split(/[\\/]/)
  if (segments.some((segment) => segment === 'scripts')) return 'script'
  if (SCRIPT_EXT.has(ext)) return 'script'
  if (segments.some((segment) => segment === 'references' || segment === 'reference' || segment === 'docs')) {
    return 'reference'
  }
  if (ext === '.md' || ext === '.markdown') return 'reference'
  return 'asset'
}

export function readPackage(skillPath: string): PackageTree {
  const entries: PackageEntry[] = []
  const root = path.resolve(skillPath)

  const walk = (dir: string, depth: number): void => {
    if (entries.length >= MAX_ENTRIES) return
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      if (entries.length >= MAX_ENTRIES) return
      if (SKIP_DIRS.has(child.name)) continue
      const full = path.join(dir, child.name)
      const rel = path.relative(root, full)
      if (child.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1)
        continue
      }
      if (!child.isFile()) continue
      if (rel === 'SKILL.md' || rel === '.skill-academy.json') continue
      if (SKIP_EXT.has(path.extname(child.name).toLowerCase())) continue
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        size = 0
      }
      const kind = classify(rel)
      const entry: PackageEntry = { kind, name: child.name, relPath: rel, size, ext: path.extname(child.name) }
      if (kind === 'script' && size <= 256_000) {
        try {
          entry.description = scriptDescription(fs.readFileSync(full, 'utf8'))
        } catch {
          entry.description = undefined
        }
      }
      entries.push(entry)
    }
  }

  walk(root, 0)

  // A folder is a unit: `notes/`, `playbooks/` or `research/` is a reference folder when it
  // holds markdown, a script folder when it holds code, an asset folder otherwise. Standard
  // names keep their meaning, so a README inside `scripts/` cannot re-type the folder.
  const byFolder = new Map<string, PackageEntry[]>()
  for (const entry of entries) {
    const parts = entry.relPath.split(/[\\/]/)
    if (parts.length < 2) continue
    const list = byFolder.get(parts[0]) ?? []
    list.push(entry)
    byFolder.set(parts[0], list)
  }
  for (const [folder, files] of byFolder) {
    const kind = STANDARD_FOLDERS[folder.toLowerCase()] ?? folderKind(files)
    for (const file of files) file.kind = kind
  }
  for (const entry of entries) {
    if (entry.kind !== 'script' || entry.description || entry.size > 256_000) continue
    try {
      entry.description = scriptDescription(fs.readFileSync(path.join(root, entry.relPath), 'utf8'))
    } catch {
      entry.description = undefined
    }
  }

  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.relPath.localeCompare(b.relPath))

  const counts: Record<PackageKind, number> = { reference: 0, script: 0, asset: 0 }
  for (const entry of entries) counts[entry.kind] += 1
  return { entries, counts }
}

export function isTextExt(ext: string): boolean {
  return TEXT_EXT.has(ext.toLowerCase())
}

/** Reads a package file, refusing anything outside the package directory. */
export function readPackageFile(skillPath: string, relPath: string): { ok: boolean; text?: string; name?: string; reason?: string } {
  const root = path.resolve(skillPath)
  const target = path.resolve(root, relPath)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: 'outside-package' }
  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }
  if (stat.size > 1_000_000) return { ok: false, reason: 'too-large' }
  try {
    return { ok: true, text: fs.readFileSync(target, 'utf8'), name: path.basename(target) }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024

/**
 * Reads a file inside a package as bytes, for the preview to show it rather than
 * describe it. Containment is resolved, not string-matched, so `..` cannot escape.
 */
export function readPackageImage(
  dir: string,
  rel: string
): { ok: true; bytes: Buffer; type: string; name: string } | { ok: false; reason: string } {
  const root = path.resolve(dir)
  const target = path.resolve(root, rel)
  if (target !== root && !target.startsWith(root + path.sep)) return { ok: false, reason: 'outside-package' }
  const type = IMAGE_TYPES[path.extname(target).toLowerCase()]
  if (!type) return { ok: false, reason: 'not-an-image' }
  try {
    const stats = fs.statSync(target)
    if (!stats.isFile()) return { ok: false, reason: 'not-a-file' }
    if (stats.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' }
    return { ok: true, bytes: fs.readFileSync(target), type, name: path.basename(target) }
  } catch {
    return { ok: false, reason: 'missing' }
  }
}

/** Same containment as readPackageImage, returned as a data URL the preview can show. */
export function readPackageImageData(
  dir: string,
  rel: string
): { ok: true; dataUrl: string; name: string } | { ok: false; reason: string } {
  const image = readPackageImage(dir, rel)
  if (!image.ok) return image
  if (image.bytes.length > 4 * 1024 * 1024) return { ok: false, reason: 'too-large' }
  return { ok: true, dataUrl: `data:${image.type};base64,${image.bytes.toString('base64')}`, name: image.name }
}
