import fs from 'node:fs'
import path from 'node:path'

const entryCache = new Map<string, { key: string; version: string; repo: string }>()
const repoCache = new Map<string, string>()

/** `https://github.com/o/r.git`, `git@github.com:o/r.git` and bare paths all read as `o/r`. */
export function shortRepo(remote: string): string {
  const cleaned = remote.trim().replace(/\.git$/i, '')
  const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(cleaned)
  if (scp) return scp[1]
  const url = cleaned.replace(/^[a-z+]+:\/\/[^/]+\//i, '')
  return url.length > 64 ? `${url.slice(0, 61)}…` : url
}

/**
 * The repository a skill came from is the nearest `.git` above it, because a skill folder
 * is almost never its own clone — it sits inside a skills repo or a dotfiles tree.
 */
export function gitRepoOf(dir: string): string {
  let current = path.resolve(dir)
  for (let depth = 0; depth < 6; depth += 1) {
    const cached = repoCache.get(current)
    if (cached) return cached
    const config = path.join(current, '.git', 'config')
    if (fs.existsSync(config)) {
      try {
        const url = /url\s*=\s*(.+)/.exec(fs.readFileSync(config, 'utf8'))?.[1]
        if (url) {
          const repo = shortRepo(url)
          repoCache.set(current, repo)
          return repo
        }
      } catch {
        /* unreadable config is not an error worth surfacing */
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  repoCache.set(path.resolve(dir), '')
  return ''
}

/** Version comes from the frontmatter, top level or under `metadata`. */
export function provenanceOf(skillPath: string, mtime: string): { version: string; repo: string } {
  const cached = entryCache.get(skillPath)
  if (cached && cached.key === mtime) return { version: cached.version, repo: cached.repo }

  let version = ''
  try {
    const head = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8').slice(0, 4000)
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? ''
    version = (/(?:^|\n)version:\s*["']?([^"'\r\n]+)/.exec(frontmatter)?.[1] ?? '').trim()
    if (!version) {
      const metadata = /(?:^|\n)metadata:\s*\r?\n((?:[ \t]+.*\r?\n?)+)/.exec(frontmatter)?.[1] ?? ''
      version = (/(?:^|\n)\s+version:\s*["']?([^"'\r\n]+)/.exec(metadata)?.[1] ?? '').trim()
    }
  } catch {
    /* a package without a readable SKILL.md already carries a health code */
  }

  const repo = gitRepoOf(skillPath)
  const value = { version: version.slice(0, 24), repo }
  entryCache.set(skillPath, { key: mtime, ...value })
  return value
}

/** Numeric-aware comparison: 1.10.0 is newer than 1.9.2, and 1.2 equals 1.2.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => (value.match(/\d+/g) ?? []).map(Number)
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return a.localeCompare(b)
}
