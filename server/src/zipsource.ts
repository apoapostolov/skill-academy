import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export interface DownloadedZip {
  archive: string
  commit: string
  release: string | null
}

/**
 * Where a zip source keeps its unpacked trees. One folder per content hash, so the tree a plan
 * named is still there when the plan is confirmed, even if the URL has moved on since.
 */
export function zipTreeDir(dataDir: string, sourceId: number, commit: string): string {
  return join(dataDir, 'sources', String(sourceId), commit.slice(0, 12))
}

/** Fetches a zip and names it by the hash of its bytes: that hash is the source's commit. */
export async function downloadZip(url: string, dataDir: string, sourceId: number): Promise<DownloadedZip> {
  const response = await fetch(url, { headers: { 'user-agent': 'skill-academy' }, redirect: 'follow' })
  if (!response.ok) throw new Error(`that URL answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const commit = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const folder = join(dataDir, 'sources', String(sourceId))
  mkdirSync(folder, { recursive: true })
  const archive = join(folder, `${commit}.zip`)
  writeFileSync(archive, bytes)
  return { archive, commit, release: response.headers.get('last-modified') }
}

/**
 * Unpacks into a folder that must already exist and must stay the container of everything
 * written: an archive entry named `../../x` would otherwise land outside it.
 */
export function extractZip(archive: string, target: string): number {
  const root = resolve(target)
  mkdirSync(root, { recursive: true })
  const zip = new AdmZip(archive)
  let written = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const destination = resolve(root, entry.entryName)
    if (destination !== root && !destination.startsWith(root + sep)) continue
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, entry.getData())
    written += 1
  }
  return written
}

/**
 * Skill folders inside an unpacked tree, as relative paths with forward slashes. A folder holding
 * `SKILL.md` is a package and the walk stops there, so a nested copy is not listed twice.
 */
export function skillDirsIn(root: string): { base: string; dirs: string[] } {
  const dirs: string[] = []
  const walk = (absolute: string, relative: string): void => {
    let names: string[]
    try {
      names = readdirSync(absolute)
    } catch {
      return
    }
    if (names.includes('SKILL.md')) {
      dirs.push(relative)
      return
    }
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue
      const child = join(absolute, name)
      try {
        if (!statSync(child).isDirectory()) continue
      } catch {
        continue
      }
      walk(child, relative ? `${relative}/${name}` : name)
    }
  }
  walk(root, '')

  // Archives usually wrap everything in one folder (`repo-main/`); read from inside it.
  let base = root
  const top = readdirSync(root).filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory()
    } catch {
      return false
    }
  })
  if (top.length === 1 && !dirs.includes('') && dirs.every((dir) => dir.startsWith(top[0] + '/'))) {
    base = join(root, top[0])
    return { base, dirs: dirs.map((dir) => dir.slice(top[0].length + 1)) }
  }
  if (dirs.includes('')) return { base: root, dirs: [''] }
  return { base, dirs }
}
