import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config'
import { getDb } from './db'
import type { Body, ConsolidateGroup } from './consolidate'
import { bodyOf, consolidateDryRun } from './consolidate'
import { sweepReferences } from './sweep'
import { insideProtected } from './safety'

/**
 * Applying a consolidation. The gate is the point: a group is only written when the caller says
 * the bodies were read, and every replaced SKILL.md goes to the trash first, so a bad merge is one
 * restore away. Routers keep their unique sections verbatim, because dropping a section silently
 * is the one thing `skill-consolidation` forbids.
 */

const TRASH = path.join(DATA_DIR, 'consolidation-trash')
const JOURNAL = path.join(DATA_DIR, 'consolidation-journal.jsonl')

export interface ApplyResult {
  key: string
  mergeType: string
  survivor: string
  pointerized: string[]
  routerized: string[]
  archived: string[]
  rewire: { files: number; occurrences: number; dangling: number }
}

function log(entry: Record<string, unknown>): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(JOURNAL, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { flag: 'a' })
}

export function archiveFile(file: string, key: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(TRASH, key.replace(/[^a-z0-9-]+/gi, '_'), stamp, 'SKILL.md')
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(file, target)
  return target
}

export function writeBody(file: string, text: string): void {
  writeFileSync(file, text, 'utf8')
}

function frontmatterBlock(text: string): string {
  const match = /^(---\r?\n[\s\S]*?\r?\n---)/.exec(text)
  return match ? match[1] : '---\n---'
}

interface Section {
  heading: string
  text: string
}

/**
 * A rewritten body is a new version of that skill. The skill's own frontmatter carries the number,
 * so the bump happens there and nowhere else.
 */
export function bumpVersion(frontmatter: string): string {
  const match = frontmatter.match(/^(\s*version:\s*)(["']?)(\d+)\.(\d+)\.(\d+)\2\s*$/m)
  if (!match) return frontmatter
  const [, prefix, quote, major, minor, patch] = match
  const next = `${prefix}${quote}${major}.${minor}.${Number(patch) + 1}${quote}`
  return frontmatter.slice(0, match.index) + next + frontmatter.slice((match.index ?? 0) + match[0].length)
}

/** The support-file table a router keeps, because those files still live in this skill's package. */
function referencesSection(body: string): string | null {
  const section = sectionsOf(body).find((entry) =>
    /^(references|reference files|support files)$/i.test(entry.heading.trim())
  )
  return section ? `## ${section.heading}\n${section.text.trimEnd()}\n` : null
}

export function sectionsOf(body: string): Section[] {
  const out: Section[] = []
  const lines = body.split(/\r?\n/)
  let current: Section | null = null
  for (const line of lines) {
    const heading = /^#{2,3}\s+(.+)$/.exec(line)
    if (heading) {
      if (current) out.push(current)
      current = { heading: heading[1].trim(), text: '' }
      continue
    }
    if (current) current.text += `${line}\n`
  }
  if (current) out.push(current)
  return out
}

export function pointerText(loser: Body, survivor: Body): string {
  const source = readFileSync(path.join(loser.dir, 'SKILL.md'), 'utf8')
  const fm = frontmatterBlock(source)
  const owned = survivor.headings.slice(0, 6).map((heading) => `“${heading}”`).join(', ')
  return [
    fm,
    '',
    `# ${loser.name}`,
    '',
    `Merged into \`${survivor.name}\`, load that.`,
    '',
    `\`${survivor.name}\` owns ${owned}.`,
    '',
    `Nothing unique was dropped: every rule this skill carried already lives in \`${survivor.name}\`.`,
    '',
    '## Related',
    '',
    `- \`${survivor.name}\``,
    ''
  ].join('\n')
}

/**
 * A router keeps its own description and its own unique sections, and points at the canonical
 * body first. The sections the survivor already carries are the ones that leave.
 */
export function routerText(loser: Body, survivor: Body): { text: string; kept: string[]; dropped: string[] } {
  const source = readFileSync(path.join(loser.dir, 'SKILL.md'), 'utf8')
  const fm = frontmatterBlock(source)
  const body = source.slice(fm.length)
  const sections = sectionsOf(body)
  const survivorHeadings = new Set(survivor.headings.map((heading) => heading.toLowerCase()))
  // The support-file table is emitted once, at the end, so it is not counted as a lane of its own.
  const isReferences = (heading: string) => /^(references|reference files|support files)$/i.test(heading.trim())
  const unique = sections.filter(
    (section) => !survivorHeadings.has(section.heading.toLowerCase()) && !isReferences(section.heading)
  )
  const dropped = sections.filter((section) => survivorHeadings.has(section.heading.toLowerCase())).map((section) => section.heading)

  // The support-file table is copied from this body, never written fresh: the files are still here,
  // and a placeholder sentence would be content nobody asked for.
  const refs = referencesSection(body)

  const text = [
    bumpVersion(fm),
    '',
    `# ${loser.name}`,
    '',
    `Load \`${survivor.name}\` first: it is the canonical body for this territory.`,
    '',
    ...unique.map((section) => `## ${section.heading}\n${section.text.trimEnd()}\n`),
    '## Related',
    '',
    `- \`${survivor.name}\``,
    '',
    ...(refs ? [refs] : [])
  ].join('\n')

  return { text, kept: unique.map((section) => section.heading), dropped }
}

export function applyConsolidation(key: string): ApplyResult | { error: string; detail?: unknown } {
  const run = consolidateDryRun()
  const group: ConsolidateGroup | undefined = run.groups.find((entry) => entry.key === key)
  if (!group) return { error: 'group-not-found', detail: { key } }
  if (!group.plan) return { error: 'not-applicable', detail: { reason: group.blocked ?? 'this group has no plan' } }
  if (group.mergeType === 'intentional-family') return { error: 'not-applicable', detail: { reason: 'router family' } }

  // The live agent library is not a test bed: a real root needs an explicit opt-in.
  const guarded = insideProtected(group.members.map((member) => member.path))
  if (guarded) {
    return {
      error: 'protected-root',
      detail: { path: guarded, hint: 'run scripts/fixture-check.sh, or set SKILL_ACADEMY_ALLOW_REAL=1 for a deliberate real merge' }
    }
  }

  const bodies = new Map<string, Body>()
  for (const member of group.members) {
    const body = bodyOf(member.path)
    if (body) bodies.set(member.name, body)
  }
  const survivor = bodies.get(group.plan.survivor)
  if (!survivor) return { error: 'survivor-missing', detail: { survivor: group.plan.survivor } }

  const archived: string[] = []
  const pointerized: string[] = []
  const routerized: string[] = []

  for (const entry of group.plan.pointerize) {
    const loser = bodies.get(entry.name)
    if (!loser) continue
    // A pointer carries no content, so it may only replace a body that has nothing unique.
    const unique = sectionsOf(readFileSync(path.join(loser.dir, 'SKILL.md'), 'utf8')).filter(
      (section) => !survivor.headings.includes(section.heading.toLowerCase())
    )
    if (unique.length) {
      return {
        error: 'would-drop-content',
        detail: { skill: loser.name, sections: unique.map((section) => section.heading) }
      }
    }
    const file = path.join(loser.dir, 'SKILL.md')
    archived.push(archiveFile(file, key))
    writeFileSync(file, pointerText(loser, survivor), 'utf8')
    pointerized.push(loser.name)
    log({ key, action: 'pointerize', path: file, survivor: survivor.name })
  }

  for (const entry of group.plan.routerize) {
    const loser = bodies.get(entry.name)
    if (!loser) continue
    const file = path.join(loser.dir, 'SKILL.md')
    const router = routerText(loser, survivor)
    archived.push(archiveFile(file, key))
    writeFileSync(file, router.text, 'utf8')
    routerized.push(loser.name)
    log({ key, action: 'routerize', path: file, survivor: survivor.name, kept: router.kept, dropped: router.dropped })
  }

  // The merge is not finished at the write: every live reference to the old name moves to the
  // winner, and the close-out check reports what is still stale or missing.
  const roots = (getDb()
    .prepare('SELECT DISTINCT root_path FROM skills')
    .all() as Array<{ root_path: string }>).map((row) => row.root_path)
  const losers = [...pointerized, ...routerized]
  const skipDirs = [survivor.dir, ...losers.map((name) => bodies.get(name)?.dir ?? '').filter(Boolean)]
  // The close-out check is scoped to the skills this merge touched: a library-wide pass reports every
  // fixture path in every unrelated body as missing.
  const touched = [survivor.dir, ...losers.map((loser) => bodies.get(loser)?.dir).filter((dir): dir is string => !!dir)]
  const sweep = losers.length
    ? sweepReferences(roots, losers, survivor.name, skipDirs, touched)
    : { rewired: [], untouched: [], dangling: [] }

  log({
    key,
    action: 'apply',
    mergeType: group.mergeType,
    pointerized,
    routerized,
    archived,
    rewired: sweep.rewired.length,
    dangling: sweep.dangling.length
  })
  return {
    key,
    mergeType: group.mergeType,
    survivor: survivor.name,
    pointerized,
    routerized,
    archived,
    rewire: { files: sweep.rewired.length, occurrences: sweep.rewired.reduce((sum, hit) => sum + hit.occurrences, 0), dangling: sweep.dangling.length }
  }
}

/** Restoring is the same move backwards: the archived SKILL.md wins. */
export function undoConsolidation(archivePath: string, originalPath: string): { restored: boolean; error?: string } {
  if (!existsSync(archivePath)) return { restored: false, error: 'archive missing' }
  // A restore writes a whole body over a path, so the archive must be the body that belongs there.
  // Without this, a wrong pair silently replaces one skill with another skill's text.
  const archived = readFileSync(archivePath, 'utf8')
  const archivedName = (archived.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m) ?? [])[1]?.trim()
  const target = path.basename(path.resolve(originalPath)) === 'SKILL.md'
    ? path.basename(path.dirname(path.resolve(originalPath)))
    : path.basename(path.resolve(originalPath))
  if (archivedName && target && archivedName.toLowerCase() !== target.toLowerCase()) {
    return { restored: false, error: `archive holds \`${archivedName}\`, not \`${target}\`` }
  }
  copyFileSync(archivePath, originalPath)
  log({ action: 'undo', archivePath, originalPath })
  return { restored: true }
}
