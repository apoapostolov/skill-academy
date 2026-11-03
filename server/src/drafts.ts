import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, LIBRARY_DIR } from './config'
import { addJournal, getDb } from './db'
import { place, isLinked, unplace } from './placement'
import { chat, providerById, type Provider } from './providers'

/**
 * A draft is a skill that does not exist yet: it lives under the app's own data directory, never in
 * an agent's folder, and it reaches an agent only when the author saves it through the placement
 * engine. Autosave is a write to the draft, not to a library.
 */
export interface DraftMeta {
  id: string
  name: string
  created: string
  updated: string
  origin: 'blank' | 'generated' | 'composite'
  intent?: string
  /** Where this draft was last saved, so a second save recognises its own package. */
  savedTo?: string
  savedHash?: string
}

export interface DraftIssue {
  code: 'no-frontmatter' | 'no-name' | 'name-mismatch' | 'no-description' | 'long-description' | 'empty-body' | 'dangling-reference' | 'unclosed-frontmatter'
  detail: string
}

export interface DraftValidation {
  ok: boolean
  name: string
  description: string
  tags: string[]
  chars: number
  issues: DraftIssue[]
}

export interface DraftView {
  meta: DraftMeta
  text: string
  validation: DraftValidation
  links: number
  savedTo: string | null
}

const DRAFTS_DIR = path.join(DATA_DIR, 'drafts')
const SNAPSHOTS = path.join(DATA_DIR, 'drafts', '.snapshots')
const TEMPLATE = (name: string): string =>
  [
    '---',
    `name: ${name}`,
    'description: ',
    'version: 1.0.0',
    'tags: []',
    '---',
    '',
    `# ${name}`,
    '',
    '## What it does',
    '',
    '',
    ''
  ].join('\n')

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'draft'
  )
}

function dirOf(id: string): string {
  return path.join(DRAFTS_DIR, id)
}

function metaPath(id: string): string {
  return path.join(dirOf(id), 'draft.json')
}

function skillPath(id: string): string {
  return path.join(dirOf(id), 'SKILL.md')
}

export function ensureDrafts(): void {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true })
}

function readMeta(id: string): DraftMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as DraftMeta
  } catch {
    return null
  }
}

function writeMeta(meta: DraftMeta): void {
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2) + '\n', 'utf8')
}

function uniqueId(base: string): string {
  let id = slug(base)
  let n = 1
  while (fs.existsSync(dirOf(id))) {
    n += 1
    id = `${slug(base)}-${n}`
  }
  return id
}

export function listDrafts(): Array<{ id: string; name: string; updated: string; origin: string; chars: number; clean: boolean; links: number }> {
  ensureDrafts()
  const out: Array<{ id: string; name: string; updated: string; origin: string; chars: number; clean: boolean; links: number }> = []
  for (const entry of fs.readdirSync(DRAFTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const meta = readMeta(entry.name)
    if (!meta) continue
    const text = readText(entry.name)
    const validation = validateDraft(text, { folder: meta.name, dir: dirOf(meta.id) })
    out.push({
      id: meta.id,
      name: meta.name,
      updated: meta.updated,
      origin: meta.origin,
      chars: text.length,
      clean: validation.ok,
      links: countLinks(dirOf(meta.id))
    })
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated))
}

function readText(id: string): string {
  try {
    return fs.readFileSync(skillPath(id), 'utf8')
  } catch {
    return ''
  }
}

function countLinks(dir: string): number {
  // Links are rows keyed by the target path, so a draft's links are its own rows.
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM skill_links WHERE target_path = ?').get(dir) as { n: number }
    return row?.n ?? 0
  } catch {
    return 0
  }
}

export function createDraft(input: { name?: string; intent?: string; text?: string; origin?: DraftMeta['origin'] } = {}): DraftView {
  ensureDrafts()
  const name = slug(input.name ?? input.intent?.split(/\s+/).slice(0, 4).join(' ') ?? 'untitled-draft')
  const id = uniqueId(name)
  const dir = dirOf(id)
  fs.mkdirSync(dir, { recursive: true })
  const text = input.text ?? TEMPLATE(name)
  fs.writeFileSync(skillPath(id), text, 'utf8')
  const at = new Date().toISOString()
  const meta: DraftMeta = { id, name, created: at, updated: at, origin: input.origin ?? 'blank', intent: input.intent }
  writeMeta(meta)
  addJournal('draft-create', { id, name, origin: meta.origin })
  return { meta, text, validation: validateDraft(text, { dir }), links: 0, savedTo: null }
}

export function readDraft(id: string): DraftView | null {
  const meta = readMeta(id)
  if (!meta) return null
  const text = readText(id)
  return {
    meta,
    text,
    validation: validateDraft(text, { dir: dirOf(meta.id) }),
    links: countLinks(dirOf(id)),
    savedTo: meta.savedTo ?? null
  }
}

export function writeDraft(id: string, text: string): DraftView | { error: string } {
  const meta = readMeta(id)
  if (!meta) return { error: 'not-found' }
  fs.writeFileSync(skillPath(id), text, 'utf8')
  meta.updated = new Date().toISOString()
  writeMeta(meta)
  return { meta, text, validation: validateDraft(text, { dir: dirOf(id) }), links: countLinks(dirOf(id)), savedTo: meta.savedTo ?? null }
}

/** Frontmatter, read the way the scanner reads it, so a draft and a saved skill agree. */
function splitFrontmatter(text: string): { data: Record<string, string>; body: string; closed: boolean } {
  if (!text.startsWith('---')) return { data: {}, body: text, closed: false }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text, closed: false }
  const block = text.slice(3, end)
  const data: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    if (value) data[match[1].toLowerCase()] = value
  }
  return { data, body: text.slice(text.indexOf('\n', end + 1) + 1), closed: true }
}

function tagList(text: string): string[] {
  const block = text.startsWith('---') ? text.slice(3, text.indexOf('\n---', 3)) : ''
  const inline = /^tags:\s*\[(.*)\]\s*$/m.exec(block)
  if (inline) {
    return inline[1]
      .split(',')
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  const lines = block.split(/\r?\n/)
  const start = lines.findIndex((line) => /^tags:\s*$/.test(line))
  if (start === -1) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line)
    if (!item) break
    out.push(item[1].trim().replace(/^["']|["']$/g, ''))
  }
  return out
}

/**
 * A draft is clean when it would be a valid skill: closed frontmatter, a name, a description, a
 * body, and no reference to a file the draft does not carry.
 */
export function validateDraft(text: string, options: { folder?: string; dir?: string } = {}): DraftValidation {
  const { folder, dir } = options
  const issues: DraftIssue[] = []
  const { data, body, closed } = splitFrontmatter(text)
  const name = data.name ?? ''
  const description = data.description ?? ''
  const tags = tagList(text)
  const trimmedBody = body.replace(/^#\s+.*$/m, '').replace(/\s+/g, ' ').trim()

  if (!text.startsWith('---')) issues.push({ code: 'no-frontmatter', detail: 'SKILL.md must start with a frontmatter block' })
  else if (!closed) issues.push({ code: 'unclosed-frontmatter', detail: 'the frontmatter block never closes with ---' })
  if (!name) issues.push({ code: 'no-name', detail: 'frontmatter has no name' })
  if (folder && name && name !== folder) {
    issues.push({ code: 'name-mismatch', detail: `frontmatter says ${name}, the draft folder is ${folder}` })
  }
  if (!description) issues.push({ code: 'no-description', detail: 'a skill needs a description: it is what a reader sees before loading it' })
  if (description.length > 240) {
    issues.push({ code: 'long-description', detail: `the description is ${description.length} characters, over 240` })
  }
  if (!trimmedBody) issues.push({ code: 'empty-body', detail: 'the body says nothing yet' })

  // A draft that names a support file must carry it: the link would break the moment it is saved.
  if (dir && fs.existsSync(dir)) {
    for (const match of text.matchAll(/(?:references|scripts|assets|templates)\/[\w./-]+/g)) {
      if (!fs.existsSync(path.join(dir, match[0]))) {
        issues.push({ code: 'dangling-reference', detail: `${match[0]} is named but the draft does not carry it` })
      }
    }
  }

  return { ok: issues.length === 0, name, description, tags, chars: text.length, issues }
}

const GENERATE_SYSTEM = [
  'You write a skill file for an agent skill library. Output only the SKILL.md text, no prose around it.',
  'Start with frontmatter: name, description, version, tags. The name is lowercase words joined by hyphens.',
  'The description is one sentence under 200 characters that says what the skill does and when to use it.',
  'Then a level-one heading, then sections of imperative rules. State rules a reader can act on.',
  'Never invent a command, a path, a number or a version. No praise, no dates, no filler.'
].join(' ')

export interface ModelOptions {
  provider?: string
  model?: string
  /** Test seam: the text the model would have returned. */
  supplied?: string
}

async function askModel(system: string, user: string, options: ModelOptions): Promise<{ text: string } | { error: string; detail?: unknown }> {
  if (options.supplied !== undefined) return { text: options.supplied }
  const providerId = options.provider ?? 'opencode-go'
  const provider = providerById(providerId) as Provider | undefined
  if (!provider) return { error: 'unknown-provider', detail: providerId }
  const answer = await chat(provider, {
    system,
    user,
    model: options.model ?? provider.models[0] ?? '',
    temperature: 0.2,
    maxTokens: 2500,
    timeoutMs: 120_000
  })
  if ('kind' in answer) {
    const detail =
      answer.kind === 'http'
        ? `HTTP ${answer.status}`
        : answer.kind === 'network'
          ? answer.message
          : answer.kind === 'no-key'
            ? `no key saved for ${answer.provider}`
            : 'the provider did not answer'
    return { error: 'provider-failed', detail }
  }
  return { text: answer.text }
}

function stripFence(text: string): string {
  const fenced = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
  return (fenced ? fenced[1] : text).trim() + '\n'
}

/** One sentence in, a draft out. The model writes the text; the draft is what the author edits. */
export async function generateDraft(
  id: string,
  options: ModelOptions & { intent: string }
): Promise<{ draft: DraftView; repairs: string[] } | { error: string; detail?: unknown }> {
  const meta = readMeta(id)
  if (!meta) return { error: 'not-found', detail: id }
  const answer = await askModel(
    GENERATE_SYSTEM,
    `Write the skill file for this intent:\n\n${options.intent.trim()}\n\nName it "${meta.name}".`,
    options
  )
  if ('error' in answer) return answer
  let text = stripFence(answer.text)
  const repairs: string[] = []
  // A model that omits the frontmatter still produced the body: fill the block rather than fail.
  if (!text.startsWith('---')) {
    text = `---\nname: ${meta.name}\ndescription: ${meta.name.replace(/-/g, ' ')}\nversion: 1.0.0\ntags: []\n---\n\n${text}`
    repairs.push('added the missing frontmatter block')
  }
  fs.writeFileSync(skillPath(id), text, 'utf8')
  meta.origin = 'generated'
  meta.intent = options.intent
  meta.updated = new Date().toISOString()
  writeMeta(meta)
  addJournal('draft-generate', { id, intent: options.intent, repairs })
  return { draft: readDraft(id)!, repairs }
}

const IMPROVE_SYSTEM = [
  'You improve a skill file. Output only the full SKILL.md text, no prose around it.',
  'Keep every rule that is still true, tighten wording, and remove repetition.',
  'Never invent a command, a path, a number or a version. Never delete the frontmatter.'
].join(' ')

export async function improveDraft(
  id: string,
  options: ModelOptions & { instruction?: string }
): Promise<{ text: string; before: string; changed: boolean } | { error: string; detail?: unknown }> {
  const draft = readDraft(id)
  if (!draft) return { error: 'not-found', detail: id }
  const answer = await askModel(
    IMPROVE_SYSTEM,
    [
      'Current skill file:',
      '',
      draft.text,
      '',
      options.instruction ? `What to change: ${options.instruction}` : 'What to change: tighten it without losing a rule.'
    ].join('\n'),
    options
  )
  if ('error' in answer) return answer
  const text = stripFence(answer.text)
  addJournal('draft-improve', { id, chars: text.length })
  return { text, before: draft.text, changed: text.trim() !== draft.text.trim() }
}

export interface SaveResult {
  draftId: string
  name: string
  directory: string
  hash: string
  placement: { ok: boolean; mode?: string; target: string; reason?: string }
  journalId: number
  replaced: boolean
}

function packageHash(dir: string): string {
  const crypto = fs.readdirSync(dir, { withFileTypes: true })
  const parts: string[] = []
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const relative = path.relative(dir, full).split(path.sep).join('/')
        parts.push(`${relative}\u0000${fs.readFileSync(full, 'utf8')}`)
      }
    }
  }
  walk(dir)
  void crypto
  return parts.join('\u0001')
}

/**
 * Save is the only step that touches an agent: the package is written into the library, then placed
 * into the chosen root through the same engine the switch uses. The bytes before the write are kept
 * so one undo puts the previous package back.
 */
export function saveDraft(
  id: string,
  input: { rootPath: string; name?: string; replace?: boolean }
): SaveResult | { error: string; detail?: unknown } {
  const draft = readDraft(id)
  if (!draft) return { error: 'not-found', detail: id }
  if (!draft.validation.ok) return { error: 'invalid-draft', detail: draft.validation.issues }
  const name = input.name?.trim() || draft.validation.name || draft.meta.name
  const target = path.join(LIBRARY_DIR, name)

  let snapshot: string | null = null
  let replaced = false
  if (fs.existsSync(target)) {
    if (!input.replace && draft.meta.savedTo !== target) return { error: 'exists', detail: target }
    snapshot = path.join(SNAPSHOTS, `${name}-${Date.now()}`)
    fs.mkdirSync(snapshot, { recursive: true })
    fs.cpSync(target, snapshot, { recursive: true })
    fs.rmSync(target, { recursive: true, force: true })
    replaced = true
  }

  fs.mkdirSync(target, { recursive: true })
  // The draft's whole folder travels: SKILL.md and any reference files the author attached.
  for (const entry of fs.readdirSync(dirOf(id), { withFileTypes: true })) {
    if (entry.name === 'draft.json') continue
    fs.cpSync(path.join(dirOf(id), entry.name), path.join(target, entry.name), { recursive: true })
  }
  const hash = packageHash(target)

  const stray = path.join(input.rootPath, name)
  if (fs.existsSync(stray) && !isLinked(stray)) unplace(stray)

  fs.mkdirSync(input.rootPath, { recursive: true })
  const placement = place(target, input.rootPath)

  const meta = readMeta(id)!
  meta.savedTo = target
  meta.savedHash = hash
  meta.updated = new Date().toISOString()
  writeMeta(meta)

  const journalId = addJournal('draft-save', {
    draftId: id,
    name,
    target,
    rootPath: input.rootPath,
    placement,
    snapshot,
    replaced
  })
  return { draftId: id, name, directory: target, hash: meta.savedHash, placement, journalId, replaced }
}

/** Undo a save: the previous bytes come back, or the package leaves the library entirely. */
export function undoDraftSave(journalId: number, snapshot: string | null, target: string, rootPath: string): { restored: boolean } {
  const placed = path.join(rootPath, path.basename(target))
  if (fs.existsSync(placed) && isLinked(placed)) {
    try {
      fs.unlinkSync(placed)
    } catch {
      /* a link that is already gone is not a failure */
    }
  }
  if (snapshot && fs.existsSync(snapshot)) {
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(snapshot, target, { recursive: true })
  } else {
    fs.rmSync(target, { recursive: true, force: true })
  }
  addJournal('draft-save-undo', { journalId, target })
  return { restored: true }
}

/** A draft's own directory, for the link and file routes. */
export function draftDirectory(id: string): string | null {
  return readMeta(id) ? dirOf(id) : null
}

/**
 * Deletes a draft by moving its folder into the app's own trash. A draft never reached a library, so
 * this is not an archive, but nothing is unlinked either: the folder is still on disk under a stamp.
 */
export function deleteDraft(id: string): { ok: boolean; movedTo?: string; reason?: string } {
  const meta = readMeta(id)
  if (!meta) return { ok: false, reason: 'not-found' }
  const from = dirOf(id)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const to = path.join(DATA_DIR, 'trash', 'drafts', `${path.basename(from)}-${stamp}`)
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  addJournal('draft-delete', { id, name: meta.name, movedTo: to })
  return { ok: true, movedTo: to }
}

/**
 * Writes the tag list into the draft's frontmatter, leaving every other line exactly as it was.
 *
 * The tags live in the file, not beside it: a saved skill's frontmatter is what an agent reads, so a
 * tag that only existed in a sidecar would disappear the moment the draft became a skill.
 */
export function writeDraftTags(id: string, tags: string[]): DraftView | { error: string } {
  const meta = readMeta(id)
  if (!meta) return { error: 'not-found' }
  const clean = Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase().replace(/[,\n#]/g, ''))
        .filter((tag) => tag.length > 0 && tag.length <= 40)
    )
  ).slice(0, 24)
  const text = readText(id)
  const withTags = applyTags(text, clean)
  fs.writeFileSync(skillPath(id), withTags, 'utf8')
  meta.updated = new Date().toISOString()
  writeMeta(meta)
  return { meta, text: withTags, validation: validateDraft(withTags, { dir: dirOf(id) }), links: countLinks(dirOf(id)), savedTo: meta.savedTo ?? null }
}

/** The frontmatter edit behind `writeDraftTags`, kept separate so it can be tested on text alone. */
export function applyTags(text: string, tags: string[]): string {
  const line = tags.length ? `tags: [${tags.join(', ')}]` : 'tags: []'
  if (!text.startsWith('---')) {
    // A draft with no frontmatter gains one: tags have nowhere else to live.
    return `---\n${line}\n---\n\n${text}`
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return `---\n${line}\n${text.slice(3)}`
  const block = text.slice(3, end)
  const lines = block.split(/\r?\n/)
  const at = lines.findIndex((candidate) => /^tags\s*:/.test(candidate))
  if (at >= 0) lines[at] = line
  else {
    // Keep `name` and `description` first: they are what every reader looks for.
    const lastNamed = Math.max(
      lines.findIndex((candidate) => /^name\s*:/.test(candidate)),
      lines.findIndex((candidate) => /^description\s*:/.test(candidate))
    )
    lines.splice(lastNamed + 1 > 0 ? lastNamed + 1 : lines.length, 0, line)
  }
  return `---${lines.join('\n')}${text.slice(end)}`
}
