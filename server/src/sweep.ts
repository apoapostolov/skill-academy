import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The sweep `skill-consolidation` requires after a merge, plus its close-out verification.
 *
 * Two rules shape it:
 *   - a live reference in a sibling body, a Related list or `related_skills` is stale and must move
 *     to the winner; a bare name in `.usage.json` is provenance metadata and must be left alone
 *   - names and paths are rewritten on different boundaries, so this only touches a name that is
 *     quoted or listed, never a substring inside a path or a URL
 */

export interface RewireHit {
  file: string
  from: string
  to: string
  occurrences: number
}

export interface SweepResult {
  rewired: RewireHit[]
  untouched: string[]
  dangling: Array<{ file: string; target: string }>
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git'])

function walkFiles(root: string, out: string[], depth = 0): void {
  if (depth > 6) return
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue
    const full = path.join(root, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) walkFiles(full, out, depth + 1)
    else if (entry.endsWith('.md')) out.push(full)
  }
}

/** Only quoted or listed names are rewritten: `name` in prose or a Related bullet, never a path. */
function rewireBody(text: string, from: string, to: string): { text: string; hits: number } {
  let hits = 0
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // `name` inside backticks, which is how a pointer, a Related bullet and a load line read.
  const quoted = new RegExp(`\`${escaped}\``, 'g')
  const next = text.replace(quoted, () => {
    hits += 1
    return `\`${to}\``
  })

  // A related_skills list entry: - name  or  related_skills: [a, b]
  const listed = new RegExp(`(related_skills:[^\\n]*?)(?<![\\w-])${escaped}(?![\\w-])`, 'g')
  const final = next.replace(listed, (_match, prefix: string) => {
    hits += 1
    return `${prefix}${to}`
  })

  return { text: final, hits }
}

/** `- name` bullets under a Related heading also count, in the plain form Hermes writes them. */
function rewireRelatedBullets(text: string, from: string, to: string): { text: string; hits: number } {
  let hits = 0
  const lines = text.split(/\r?\n/)
  let inRelated = false
  const next = lines.map((line) => {
    if (/^#{2,3}\s/.test(line)) {
      inRelated = /related/i.test(line)
      return line
    }
    if (!inRelated) return line
    const bullet = /^(\s*[-*]\s+)(.*)$/.exec(line)
    if (!bullet) return line
    const bare = bullet[2].trim().replace(/[`.,]$/g, '')
    if (bare !== from) return line
    hits += 1
    return `${bullet[1]}\`${to}\``
  })
  return { text: next.join('\n'), hits }
}

export function sweepReferences(
  roots: string[],
  losers: string[],
  winner: string,
  skipDirs: string[],
  scopeTo?: string[]
): SweepResult {
  // A name that is already the winner needs no rewire, and a no-op rewrite would be reported as work.
  const moving = losers.filter((loser) => loser !== winner)
  const files: string[] = []
  for (const root of roots) walkFiles(root, files)
  const skip = new Set(skipDirs.map((dir) => path.resolve(dir)))
  const rewired: RewireHit[] = []
  const untouched: string[] = []

  for (const file of files) {
    if (skip.has(path.resolve(path.dirname(file)))) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let next = text
    let total = 0
    for (const loser of moving) {
      const quoted = rewireBody(next, loser, winner)
      const bullets = rewireRelatedBullets(quoted.text, loser, winner)
      next = bullets.text
      total += quoted.hits + bullets.hits
    }
    if (total > 0 && next !== text) {
      writeFileSync(file, next, 'utf8')
      rewired.push({ file, from: losers.join(', '), to: winner, occurrences: total })
    } else if (total === 0) {
      untouched.push(file)
    }
  }

  // Close-out: every references/ or scripts/ target named in a body must exist. It is scoped to
  // the skills this merge touched, because a library-wide pass reports every fixture and example
  // path in every body as missing.
  const dangling: Array<{ file: string; target: string }> = []
  const inScope = scopeTo ? files.filter((file) => scopeTo.some((dir) => path.resolve(file).startsWith(path.resolve(dir) + path.sep))) : files
  for (const file of inScope) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:references|scripts|assets|templates)\/([\w.-]+\.[a-z]{2,4})/g)) {
      const target = path.join(path.dirname(file), match[0])
      if (!existsSync(target)) dangling.push({ file, target: match[0] })
    }
  }

  return { rewired, untouched, dangling }
}
