import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { getDb } from './db'
import { parseYaml } from './skill'

/**
 * Improve: the same checks Hermes runs over its own skill library, applied to whatever roots
 * this app has indexed. Rule ids are copied from `skill-curation` and `scripts/family-audit.py`
 * on purpose, so a finding here can be argued against that script's output line for line.
 *
 * Nothing in this file writes. It reads SKILL.md files and the registry document and reports.
 */

export interface ImproveFinding {
  rule: RuleId
  severity: 'error' | 'warn'
  skill: string
  path: string
  /** The evidence a reader needs to agree or disagree, never a summary of it. */
  detail: string
}

export type RuleId =
  | 'category-mismatch'
  | 'unexpected-unfiled'
  | 'multi-family'
  | 'undocumented-family'
  | 'empty-family'
  | 'member-drift'
  | 'description-over-budget'
  | 'description-no-period'
  | 'stub-body'
  | 'name-drift'
  | 'dormant-tags'
  | 'shadow-category'
  | 'ambiguous-name'

export const RULES: Array<{ id: RuleId; severity: 'error' | 'warn'; source: string; why: string }> = [
  { id: 'category-mismatch', severity: 'error', source: 'family-audit.py:1', why: 'category must equal the top-level folder; the field never follows a move on its own' },
  { id: 'unexpected-unfiled', severity: 'error', source: 'family-audit.py:2', why: 'a skill with no family: tag cannot be found by the family it belongs to' },
  { id: 'multi-family', severity: 'error', source: 'family-audit.py:2', why: 'one primary family per skill; a second one splits curation' },
  { id: 'undocumented-family', severity: 'error', source: 'family-audit.py:3', why: 'a family used on disk but absent from CATEGORIES.md has no owner' },
  { id: 'empty-family', severity: 'error', source: 'family-audit.py:4', why: 'a registry family with no member is a stale row' },
  { id: 'member-drift', severity: 'warn', source: 'family-audit.py:5', why: 'the registry count and the disk disagree, so one of them is out of date' },
  { id: 'description-over-budget', severity: 'error', source: 'skill-curation: description budget', why: 'the index truncates at 57 characters and the routing signal is lost' },
  { id: 'description-no-period', severity: 'warn', source: 'skill-curation: description budget', why: 'one sentence, trigger first, ending in a period' },
  { id: 'stub-body', severity: 'error', source: 'skill-curation: ingest completion check', why: 'a stub routes fine and delivers nothing when loaded' },
  { id: 'name-drift', severity: 'error', source: 'skill-curation: taxonomy', why: 'name is the leaf directory name; a mismatch breaks lookup' },
  { id: 'dormant-tags', severity: 'warn', source: 'skill-curation: tags', why: 'tags live in metadata.hermes.tags; a top-level tags: key is a dormant fallback' },
  { id: 'shadow-category', severity: 'warn', source: 'skill-curation: taxonomy', why: 'a category nested under metadata.hermes makes naive parsers disagree with the tree' },
  { id: 'ambiguous-name', severity: 'warn', source: 'skill-curation: dated backups', why: 'a dated backup copying a live name makes the bare name unresolvable' }
]

/** Deliberately unfiled, as the Hermes audit declares them. */
const KNOWN_UNFILED = new Set([
  'jevgrep', 'bg-law', 'blender-win11', 'mefi-studio-ops', 'reddit',
  'astryx', 'browser-extension-authoring', 'ledger-backed-wallets'
])

const SKIP_DIRS = new Set(['__pycache__', 'node_modules', 'scripts', 'references', 'templates', 'assets'])

const ROW = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(\d+)\s*\|/

interface Parsed {
  dir: string
  name: string
  folder: string
  rootPath: string
  category: string
  families: string[]
  description: string
  bodyChars: number
  hasTopLevelTags: boolean
  hasHermesTags: boolean
  shadowCategory: boolean
  declaredName: string
}

function readFrontmatter(file: string) {
  const text = readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const block = match ? match[1] : ''
  return { block, rest: text.slice(match ? match[0].length : 0), text }
}

function tagsFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((entry) => entry.replace(/^["']|["']$/g, '').trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  return []
}

/** The app's reader yields `metadata.hermes.tags` as a flat key; a nested reader yields objects. */
function pick(fm: Record<string, unknown>, dotted: string): unknown {
  if (dotted in fm) return fm[dotted]
  const parts = dotted.split('.')
  let cursor: unknown = fm
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function parse(dir: string, rootPath: string): Parsed | null {
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  const { block, rest } = readFrontmatter(file)
  const fm = parseYaml(block) as Record<string, unknown>
  const hermesTags = tagsFrom(pick(fm, 'metadata.hermes.tags'))
  const topTags = tagsFrom(pick(fm, 'tags'))
  const tags = hermesTags.length ? hermesTags : topTags
  const rel = path.relative(rootPath, dir)
  // family-audit.py reads the same way: the first segment is the category folder, and a skill
  // sitting directly in the library root has none. A doubled name (github/github) is a folder.
  const folder = rel.includes(path.sep) ? rel.split(path.sep)[0] : ''
  return {
    dir,
    name: path.basename(dir),
    folder,
    rootPath,
    category: typeof fm.category === 'string' ? fm.category : '',
    families: tags.filter((tag) => tag.startsWith('family:')).map((tag) => tag.slice(7)),
    description: typeof fm.description === 'string' ? fm.description : '',
    bodyChars: rest.trim().length,
    hasTopLevelTags: topTags.length > 0,
    hasHermesTags: hermesTags.length > 0,
    shadowCategory: (() => {
      const nested = pick(fm, 'metadata.hermes.category')
      return typeof nested === 'string' && nested !== ''
    })(),
    declaredName: typeof fm.name === 'string' ? fm.name : ''
  }
}

function registryFamilies(rootPath: string): Map<string, number> | null {
  const file = path.join(rootPath, 'CATEGORIES.md')
  if (!existsSync(file)) return null
  const declared = new Map<string, number>()
  let section = ''
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim().toLowerCase()
      continue
    }
    if (!section.startsWith('famil')) continue
    const row = ROW.exec(line)
    if (row) declared.set(row[1], Number(row[2]))
  }
  return declared
}

function walk(rootPath: string, dir: string, out: Parsed[], depth = 0) {
  if (depth > 4) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    if (existsSync(path.join(full, 'SKILL.md'))) {
      const parsed = parse(full, rootPath)
      if (parsed) out.push(parsed)
      continue
    }
    walk(rootPath, full, out, depth + 1)
  }
}

export function improveDryRun(): {
  rules: typeof RULES
  findings: ImproveFinding[]
  summary: Record<string, number>
  roots: Array<{ root: string; skills: number; registry: boolean }>
  ms: number
} {
  const started = Date.now()
  const roots = (getDb()
    .prepare(`SELECT DISTINCT root_path FROM skills ORDER BY root_path`)
    .all() as Array<{ root_path: string }>).map((row) => row.root_path)

  const findings: ImproveFinding[] = []
  const rootReport: Array<{ root: string; skills: number; registry: boolean }> = []

  for (const rootPath of roots) {
    const parsed: Parsed[] = []
    walk(rootPath, rootPath, parsed)
    const declared = registryFamilies(rootPath)
    rootReport.push({ root: rootPath, skills: parsed.length, registry: !!declared })

    for (const skill of parsed) {
      const push = (rule: RuleId, detail: string) => {
        const meta = RULES.find((entry) => entry.id === rule)
        findings.push({ rule, severity: meta?.severity ?? 'warn', skill: skill.name, path: skill.dir, detail })
      }

      // Family, category and registry rules belong to the library that owns CATEGORIES.md.
      // A platform copy of a skill has no registry, so holding it to one would be noise.
      if (declared && skill.category && skill.category !== skill.folder) {
        push('category-mismatch', `category=${JSON.stringify(skill.category)} folder=${JSON.stringify(skill.folder)}`)
      }
      if (declared && skill.families.length === 0 && !KNOWN_UNFILED.has(skill.name)) {
        push('unexpected-unfiled', 'no family: tag and not on the known-unfiled list')
      }
      if (declared && skill.families.length > 1) {
        push('multi-family', `family tags: ${skill.families.join(', ')}`)
      }
      if (skill.description.length > 60) {
        push('description-over-budget', `${skill.description.length} characters, index shows 57`)
      }
      if (skill.description && !skill.description.trim().endsWith('.')) {
        push('description-no-period', `ends with ${JSON.stringify(skill.description.trim().slice(-1))}`)
      }
      if (skill.bodyChars > 0 && skill.bodyChars < 800) {
        push('stub-body', `body is ${skill.bodyChars} characters, a stub routes but delivers nothing`)
      }
      if (skill.declaredName && skill.declaredName !== skill.name) {
        push('name-drift', `name=${JSON.stringify(skill.declaredName)} folder=${JSON.stringify(skill.name)}`)
      }
      if (declared && skill.hasTopLevelTags && !skill.hasHermesTags) {
        push('dormant-tags', 'tags: at the top level only, so the loader reads nothing')
      }
      if (declared && skill.shadowCategory) {
        push('shadow-category', 'metadata.hermes.category duplicates the top-level field')
      }
      if (/-bak-\d{4}/.test(skill.name)) {
        push('ambiguous-name', 'a dated backup directory that copies a live skill name')
      }
    }

    if (declared) {
      const onDisk = new Map<string, Set<string>>()
      for (const skill of parsed) {
        for (const family of skill.families) {
          const bucket = onDisk.get(family) ?? new Set<string>()
          bucket.add(skill.name)
          onDisk.set(family, bucket)
        }
      }
      for (const [family, members] of onDisk) {
        if (!declared.has(family)) {
          findings.push({
            rule: 'undocumented-family',
            severity: 'error',
            skill: `family:${family}`,
            path: rootPath,
            detail: `${members.size} skill(s) carry it, CATEGORIES.md does not declare it: ${[...members].sort().slice(0, 6).join(', ')}`
          })
        }
      }
      for (const [family, count] of declared) {
        const members = onDisk.get(family)
        if (!members) {
          findings.push({
            rule: 'empty-family',
            severity: 'error',
            skill: `family:${family}`,
            path: path.join(rootPath, 'CATEGORIES.md'),
            detail: `declared with ${count} member(s), no skill carries the tag`
          })
          continue
        }
        if (members.size !== count) {
          findings.push({
            rule: 'member-drift',
            severity: 'warn',
            skill: `family:${family}`,
            path: path.join(rootPath, 'CATEGORIES.md'),
            detail: `registry=${count} disk=${members.size}`
          })
        }
      }
    }
  }

  const summary: Record<string, number> = {}
  for (const finding of findings) summary[finding.rule] = (summary[finding.rule] ?? 0) + 1

  return { rules: RULES, findings, summary, roots: rootReport, ms: Date.now() - started }
}
