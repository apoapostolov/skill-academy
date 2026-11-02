import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface SkillIssue {
  code: 'no-frontmatter' | 'no-description' | 'long-body' | 'dangling-reference' | 'name-mismatch' | 'unreadable'
  detail: string
}

export interface SkillRecord {
  path: string
  name: string
  description: string
  rootPath: string
  scope: string
  bodyChars: number
  tokens: number
  tags: string[]
  packageHash: string
  mtime: string
  files: number
  bytes: number
  /** Indexed for search only; never stored in the skills table. */
  text: string
  health: SkillIssue[]
}

const MAX_PACKAGE_FILES = 400
const LONG_BODY_CHARS = 24_000
/** Rough on purpose: four characters per token, labelled as an estimate everywhere. */
const CHARS_PER_TOKEN = 4

interface Frontmatter {
  data: Record<string, string | string[]>
  body: string
  present: boolean
}

function parseYamlLite(block: string): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {}
  let currentKey: string | null = null

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue
    const listItem = rawLine.match(/^\s*-\s+(.*)$/)
    if (listItem && currentKey) {
      const previous = data[currentKey]
      const value = stripQuotes(listItem[1].trim())
      data[currentKey] = Array.isArray(previous) ? [...previous, value] : [value]
      continue
    }
    const pair = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!pair) continue
    const [, key, rawValue] = pair
    currentKey = key
    const value = rawValue.trim()
    if (!value) {
      data[key] = []
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => stripQuotes(item.trim()))
        .filter(Boolean)
    } else {
      data[key] = stripQuotes(value)
    }
  }
  return data
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function splitFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { data: {}, body: text, present: false }
  const close = text.indexOf('\n---', 3)
  if (close === -1) return { data: {}, body: text, present: false }
  const block = text.slice(3, close)
  const afterClose = text.indexOf('\n', close + 1)
  const body = afterClose === -1 ? '' : text.slice(afterClose + 1)
  return { data: parseYamlLite(block), body, present: true }
}

function firstParagraph(body: string): string {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 200)
}

function listPackageFiles(dir: string): { relative: string; size: number }[] {
  const out: { relative: string; size: number }[] = []
  const walk = (current: string, depth: number) => {
    if (out.length >= MAX_PACKAGE_FILES || depth > 4) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_PACKAGE_FILES) return
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolute, depth + 1)
      } else if (entry.isFile()) {
        try {
          out.push({ relative: path.relative(dir, absolute), size: fs.statSync(absolute).size })
        } catch {
          /* file vanished mid-scan */
        }
      }
    }
  }
  walk(dir, 0)
  return out.sort((a, b) => a.relative.localeCompare(b.relative))
}

export function parseSkill(dir: string, rootPath: string, scope: string): SkillRecord | null {
  const file = path.join(dir, 'SKILL.md')
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const { data, body, present } = splitFrontmatter(raw)
  const folder = path.basename(dir)
  const declaredName = typeof data.name === 'string' ? data.name.trim() : ''
  const name = declaredName || folder
  const declaredDescription = typeof data.description === 'string' ? data.description.trim() : ''
  const description = declaredDescription || firstParagraph(body)

  const tagSource = data.tags ?? data.keywords
  const tags = Array.isArray(tagSource) ? tagSource.slice(0, 24) : []

  const files = listPackageFiles(dir)
  const bytes = files.reduce((sum, entry) => sum + entry.size, 0)
  const hash = crypto.createHash('sha256').update(raw)
  for (const entry of files) hash.update(`${entry.relative}\u0000${entry.size}\u0000`)
  const packageHash = hash.digest('hex').slice(0, 32)

  const health: SkillIssue[] = []
  if (!present) health.push({ code: 'no-frontmatter', detail: 'SKILL.md has no frontmatter block' })
  if (!description) health.push({ code: 'no-description', detail: 'No description in frontmatter or body' })
  if (body.length > LONG_BODY_CHARS) {
    health.push({ code: 'long-body', detail: `Body is ${body.length} characters, over ${LONG_BODY_CHARS}` })
  }
  if (declaredName && declaredName !== folder) {
    health.push({ code: 'name-mismatch', detail: `Frontmatter says "${declaredName}", folder is "${folder}"` })
  }

  const referenced = new Set<string>()
  for (const match of raw.matchAll(/(?:references|scripts|assets)\/([\w./-]+)/g)) referenced.add(match[0])
  for (const relative of referenced) {
    if (!fs.existsSync(path.join(dir, relative))) {
      health.push({ code: 'dangling-reference', detail: `Missing ${relative}` })
      if (health.length > 12) break
    }
  }

  let mtime = new Date().toISOString()
  try {
    mtime = fs.statSync(file).mtime.toISOString()
  } catch {
    /* keep now */
  }

  return {
    path: dir,
    name,
    description: description.slice(0, 300),
    rootPath,
    scope,
    bodyChars: raw.length,
    tokens: Math.ceil(raw.length / CHARS_PER_TOKEN),
    tags,
    packageHash,
    mtime,
    files: files.length,
    bytes,
    text: body.slice(0, 20_000),
    health
  }
}

export function readSkillBody(dir: string, limit = 12_000): string {
  try {
    const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    const { body } = splitFrontmatter(raw)
    return body.slice(0, limit)
  } catch {
    return ''
  }
}
