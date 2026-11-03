import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb, addJournal, removeByPath } from './db'
import { DATA_DIR } from './config'
import { archiveSkill, restoreTrash } from './lifecycle'
import { consolidateDryRun } from './consolidate'
import { foldGroup, rememberFold } from './fold'
import { placementPreview, type PlacementOutcome } from './promote'
import { readBody } from './links'
import { diffPackages, snapshotPackage } from './plandiff'
import type { PackageDiff } from './plandiff'

/**
 * Consolidate into X: several skills fold into one new package, and every source goes to the trash.
 *
 * The whole thing is staged so a failure halfway does not leave a library with two of four skills
 * moved and a half-written X: create, verify, move, verify, and put everything back on any error.
 */

export interface MergeIntoTarget {
  name: string
  path: string
  hash: string
  version: string | null
  files: number
  bytes: number
  protected: boolean
}

export interface MergeIntoXPlan {
  planId: string
  groupKey: string
  name: string
  directory: string
  members: MergeIntoTarget[]
  survivors: number
  body: string
  frontmatter: string
  diff: PackageDiff
  blockers: string[]
  carriedFiles: Array<{ from: string; to: string; bytes: number }>
  /** Per agent root: which copy it holds, and that the copy is leaving. */
  placements: PlacementOutcome[]
  /** True when the group folds into a skill that already exists rather than a new one. */
  existing?: boolean
  model: string | null
  audit: { keptRules: number; totalRules: number; droppedRules: string[]; status: string } | null
  ms: number
}

const plans = new Map<string, MergeIntoXPlan>()

function hashOfPackage(dir: string): string {
  return [...snapshotPackage(dir).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, file]) => `${name}:${file.hash}`)
    .join('|')
    .split('')
    .reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) | 0), 7)
    .toString(16)
    .replace('-', '')
}

function versionOf(dir: string): string | null {
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  const match = /^version:\s*["']?([^"'\n]+)["']?\s*$/m.exec(readFileSync(file, 'utf8').slice(0, 4000))
  return match ? match[1].trim() : null
}

export interface MergeIntoXInput {
  groupKey: string
  name: string
  provider?: string
  model?: string
  /** Test seam: a body already written by the model. */
  suppliedBody?: string
}

export async function planMergeIntoX(input: MergeIntoXInput): Promise<MergeIntoXPlan | { error: string; detail?: unknown }> {
  const started = Date.now()
  const run = consolidateDryRun()
  const group = run.groups.find((entry) => entry.key === input.groupKey)
  if (!group) return { error: 'group-not-found', detail: input.groupKey }
  if (group.members.length < 2) return { error: 'group-too-small', detail: group.members.length }

  const name = input.name.trim().replace(/\s+/g, '-').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return { error: 'bad-name', detail: name }

  const first = group.members[0]
  const directory = path.join(path.dirname(first.path), name)
  const blockers: string[] = []
  if (group.liveRoot) blockers.push(`the group lives in a protected root: ${first.path}`)
  if (existsSync(directory)) blockers.push(`a skill directory named ${name} already exists at ${directory}`)
  const taken = getDb().prepare('SELECT name FROM skills WHERE lower(name) = ?').get(name) as { name: string } | undefined
  if (taken) blockers.push(`the library already lists a skill named ${name}`)

  const members: MergeIntoTarget[] = group.members.map((member) => ({
    name: member.name,
    path: member.path,
    hash: hashOfPackage(member.path),
    version: versionOf(member.path),
    files: snapshotPackage(member.path).size,
    bytes: [...snapshotPackage(member.path).values()].reduce((sum, file) => sum + file.bytes, 0),
    protected: Boolean(group.liveRoot)
  }))

  const folded = input.suppliedBody
    ? { text: input.suppliedBody }
    : await foldGroup(input.groupKey, input.provider ?? 'opencode-go', input.model ?? 'deepseek-v4.1-flash')
  if ('error' in folded) return { error: folded.error, detail: 'detail' in folded ? folded.detail : undefined }
  const merged = folded.text.trim()
  if (!merged) return { error: 'empty-body' }

  // The survivor's frontmatter is the skeleton; the name is the one the user chose.
  const survivorPath = group.members.find((member) => member.name === group.plan?.survivor)?.path ?? first.path
  const survivorRaw = readFileSync(path.join(survivorPath, 'SKILL.md'), 'utf8')
  const close = survivorRaw.indexOf('\n---', 3)
  const head = close === -1 ? '---\n---\n' : survivorRaw.slice(0, close + 4) + '\n'
  const tags = new Set<string>()
  for (const member of group.members) {
    const text = readFileSync(path.join(member.path, 'SKILL.md'), 'utf8').slice(0, 4000)
    const inline = /^tags:\s*\[(.*)\]\s*$/m.exec(text)
    if (inline) for (const tag of inline[1].split(',')) if (tag.trim()) tags.add(tag.trim().replace(/^["']|["']$/g, ''))
  }
  const description = (() => {
    const match = /^description:\s*(.*)$/m.exec(survivorRaw.slice(0, 4000))
    return match ? match[1].trim() : `${name} is a composite of ${group.members.map((member) => member.name).join(', ')}.`
  })()
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    tags.size ? `tags: [${[...tags].join(', ')}]` : '',
    `version: ${versionOf(survivorPath) ?? '1.0.0'}`,
    '---',
    ''
  ]
    .filter((line) => line !== '')
    .join('\n')
  const fullText = `${frontmatter}\n${merged}\n`

  const carriedFiles: MergeIntoXPlan['carriedFiles'] = []
  const after = new Map<string, string | null>()
  after.set('SKILL.md', fullText)
  for (const member of group.members) {
    for (const [relative, file] of snapshotPackage(member.path)) {
      if (relative === 'SKILL.md') continue
      // Two members can share a frontmatter name, so the folder is named after the directory.
      const normalisedSource = relative.split(path.sep).join('/')
      const inner = normalisedSource.startsWith('references/') ? normalisedSource.slice('references/'.length) : normalisedSource
      const folder = path.basename(member.path)
      const normalised =
        member.path === survivorPath ? normalisedSource : `references/from-${folder}/${inner}`
      if (after.has(normalised)) continue
      if (file.text !== null) after.set(normalised, file.text)
      carriedFiles.push({ from: `${member.name}/${relative}`, to: normalised, bytes: file.bytes })
    }
  }

  // Staged for the diff: a plan that cannot show an image it will carry is not a plan.
  const staging = path.join(DATA_DIR, 'staging', `merge-${randomUUID().slice(0, 8)}`)
  try {
    mkdirSync(staging, { recursive: true })
    writeFileSync(path.join(staging, 'SKILL.md'), fullText, 'utf8')
    const byNameForStage = new Map(group.members.map((member) => [member.name, member.path]))
    for (const entry of carriedFiles) {
      const owner = entry.from.split('/')[0]
      const source = path.join(byNameForStage.get(owner) ?? '', entry.from.slice(owner.length + 1))
      if (!existsSync(source)) continue
      const target = path.join(staging, entry.to)
      mkdirSync(path.dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true })
    }
  } catch {
    /* the diff falls back to text-only when the staging copy cannot be written */
  }
  const stagedDiff = existsSync(staging)
    ? diffPackages(null, { dir: staging }, { images: true })
    : diffPackages(null, { files: after }, { images: true })
  rmSync(staging, { recursive: true, force: true })

  const plan: MergeIntoXPlan = {
    planId: randomUUID(),
    groupKey: input.groupKey,
    name,
    directory,
    members,
    survivors: group.members.length,
    body: merged,
    frontmatter,
    diff: stagedDiff,
    blockers,
    carriedFiles,
    placements: placementPreview(group.members, group.members.map((member) => member.path)),
    model: input.suppliedBody ? null : (input.model ?? 'deepseek-v4.1-flash'),
    audit: 'audit' in folded && folded.audit ? (folded.audit as MergeIntoXPlan['audit']) : null,
    ms: Date.now() - started
  }
  plans.set(plan.planId, plan)
  return plan
}

export interface MergeIntoXResult {
  applied: boolean
  planId: string
  name: string
  directory: string
  trashed: Array<{ name: string; path: string; trashId: number | null }>
  files: number
  hash: string
  journalId: number
  ms: number
}

/**
 * `failAfter` exists for the rollback proof: the harness makes the third move fail and checks that
 * the first two came back. Nothing in the app passes it.
 */
export function applyMergeIntoX(
  planId: string,
  ack = false,
  failAfter?: number
): MergeIntoXResult | { error: string; detail?: unknown } {
  const started = Date.now()
  const plan = plans.get(planId)
  if (!plan) return { error: 'plan-unknown', detail: planId }
  if (plan.blockers.length && ack !== true) return { error: 'plan-blocked', detail: plan.blockers }

  for (const member of plan.members) {
    if (!existsSync(member.path)) return { error: 'member-vanished', detail: member.path }
    if (hashOfPackage(member.path) !== member.hash) {
      return { error: 'plan-stale', detail: { path: member.path, expected: member.hash, found: hashOfPackage(member.path) } }
    }
  }
  if (existsSync(plan.directory) && plan.blockers.length === 0) {
    return { error: 'name-taken', detail: plan.directory }
  }

  const trashed: MergeIntoXResult['trashed'] = []
  let directoryCreated = false
  try {
    // 1. Write X somewhere no scan can see it half-finished.
    const staging = `${plan.directory}.staging`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    directoryCreated = true
    const byName = new Map(plan.members.map((member) => [member.name, member.path]))
    for (const entry of plan.carriedFiles) {
      const member = entry.from.split('/')[0]
      const relative = entry.from.slice(member.length + 1)
      const source = path.join(byName.get(member) ?? '', relative)
      if (!existsSync(source)) continue
      const target = path.join(staging, entry.to)
      mkdirSync(path.dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true })
    }
    writeFileSync(path.join(staging, 'SKILL.md'), `${plan.frontmatter}\n${plan.body}\n`, 'utf8')

    // 2. Move every source to the trash. A failure here is put back before anything else happens.
    for (const [index, member] of plan.members.entries()) {
      if (failAfter !== undefined && index >= failAfter) throw new Error(`simulated failure on ${member.name}`)
      const row = getDb().prepare('SELECT id FROM skills WHERE path = ? OR real_path = ?').get(member.path, member.path) as { id: number } | undefined
      const archived = row ? archiveSkill(row.id, 'consolidate-into-x') : { ok: false, trashId: undefined }
      trashed.push({ name: member.name, path: member.path, trashId: 'trashId' in archived ? (archived.trashId ?? null) : null })
      if (!('ok' in archived) || archived.ok !== true) {
        throw new Error(`could not move ${member.name}: ${'reason' in archived ? archived.reason : 'unknown'}`)
      }
    }

    // 3. Promote the staged package into place.
    cpSync(staging, plan.directory, { recursive: true })
    rmSync(staging, { recursive: true, force: true })
    const hash = hashOfPackage(plan.directory)
    const files = snapshotPackage(plan.directory).size
    for (const member of plan.members) removeByPath(member.path)

    const journalId = addJournal('consolidate-into-x', {
      planId: plan.planId,
      groupKey: plan.groupKey,
      name: plan.name,
      directory: plan.directory,
      trashed,
      hash
    })
    plans.delete(planId)
    return { applied: true, planId, name: plan.name, directory: plan.directory, trashed, files, hash, journalId, ms: Date.now() - started }
  } catch (error) {
    // Put back every package that moved, then remove whatever of X exists.
    for (const entry of trashed) {
      if (entry.trashId) restoreTrash(entry.trashId)
    }
    if (directoryCreated) {
      rmSync(`${plan.directory}.staging`, { recursive: true, force: true })
      if (existsSync(plan.directory) && plan.blockers.length === 0) rmSync(plan.directory, { recursive: true, force: true })
    }
    return { error: 'apply-failed', detail: { message: (error as Error).message, restored: trashed.map((entry) => entry.name) } }
  }
}

export function mergeIntoXPlan(planId: string): MergeIntoXPlan | undefined {
  return plans.get(planId)
}

export function forgetPlan(planId: string): void {
  plans.delete(planId)
}

/**
 * Fold a group into a skill that already exists.
 *
 * The target is not replaced: its frontmatter and its name stay, its body joins the merge as one
 * more source, and every group member moves to the trash afterwards. Before a byte of the target is
 * written the whole package is copied aside, so undo puts the previous package back exactly.
 */
export interface FoldIntoExistingResult {
  applied: boolean
  planId: string
  name: string
  directory: string
  backup: string
  trashed: Array<{ name: string; path: string; trashId: number | null }>
  files: number
  hash: string
  journalId: number
  ms: number
}

function frontmatterOf(text: string): { frontmatter: string; name: string | null } {
  const match = /^(---\r?\n[\s\S]*?\r?\n---)/.exec(text)
  const frontmatter = match ? match[1] : '---\n---'
  const nameMatch = /^name:\s*(.+)$/m.exec(frontmatter)
  return { frontmatter, name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : null }
}

export async function planFoldIntoExisting(input: {
  groupKey: string
  targetPath: string
  provider: string
  model: string
  /** The harness and the audit path supply a body instead of paying for a model call. */
  suppliedBody?: string
}): Promise<MergeIntoXPlan | { error: string; detail?: unknown }> {
  const started = Date.now()
  const target = path.resolve(input.targetPath)
  const run = consolidateDryRun()
  const group = run.groups.find((entry) => entry.key === input.groupKey)
  if (!group) return { error: 'group-not-found', detail: { key: input.groupKey } }
  if (!group.plan) return { error: 'not-applicable', detail: { reason: group.blocked ?? 'no plan' } }
  if (group.members.some((member) => path.resolve(member.path) === target)) {
    return { error: 'target-in-group', detail: { path: target, note: 'a copy of this group cannot absorb the group; promote a newer copy instead' } }
  }
  const targetFile = path.join(target, 'SKILL.md')
  if (!existsSync(targetFile)) return { error: 'target-not-a-skill', detail: { path: target } }
  const targetText = readFileSync(targetFile, 'utf8')
  const identity = frontmatterOf(targetText)
  const name = identity.name ?? path.basename(target)

  const folded = await foldGroup(input.groupKey, input.provider, input.model, input.suppliedBody, [
    { name, dir: target }
  ])
  if ('error' in folded) return folded
  if (!('text' in folded)) return { error: 'fold-failed', detail: folded }

  const blockers: string[] = []
  if (folded.status !== 'clean') {
    blockers.push(`the fold loses ${folded.droppedRules.length} line(s) the sources carry`)
  }
  const composite = readBody(target)
  if (composite && /^##\s+From\s+/m.test(composite)) {
    blockers.push('the target is a composite skill; fold into a plain skill or ingest the group instead')
  }

  const body = folded.text
  const fullText = `${identity.frontmatter}\n${body}\n`

  const carriedFiles: MergeIntoXPlan['carriedFiles'] = []
  const after = new Map<string, string | null>()
  after.set('SKILL.md', fullText)
  for (const member of group.members) {
    for (const [relative, file] of snapshotPackage(member.path)) {
      if (relative === 'SKILL.md') continue
      const normalisedSource = relative.split(path.sep).join('/')
      const inner = normalisedSource.startsWith('references/')
        ? normalisedSource.slice('references/'.length)
        : normalisedSource
      const normalised = `references/from-${path.basename(member.path)}/${inner}`
      if (after.has(normalised)) continue
      if (file.text !== null) after.set(normalised, file.text)
      carriedFiles.push({ from: `${member.name}/${relative}`, to: normalised, bytes: file.bytes })
    }
  }

  const staging = path.join(DATA_DIR, 'staging', `fold-${randomUUID().slice(0, 8)}`)
  let diff: PackageDiff
  try {
    mkdirSync(staging, { recursive: true })
    for (const [relative, text] of after) {
      if (text === null) continue
      const at = path.join(staging, relative)
      mkdirSync(path.dirname(at), { recursive: true })
      writeFileSync(at, text, 'utf8')
    }
    diff = diffPackages(target, { dir: staging }, { images: true })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  const members: MergeIntoTarget[] = group.members.map((member) => ({
    name: member.name,
    path: member.path,
    hash: hashOfPackage(member.path),
    version: member.version ?? null,
    files: snapshotPackage(member.path).size,
    bytes: member.chars,
    protected: false
  }))

  const plan: MergeIntoXPlan = {
    planId: randomUUID(),
    groupKey: input.groupKey,
    name,
    directory: target,
    existing: true,
    members,
    survivors: group.members.length,
    body,
    frontmatter: identity.frontmatter,
    diff,
    blockers,
    carriedFiles,
    placements: placementPreview(group.members, group.members.map((member) => member.path)),
    model: input.model,
    audit: { keptRules: folded.keptRules, totalRules: folded.totalRules, droppedRules: folded.droppedRules, status: folded.status },
    ms: Date.now() - started
  }
  plans.set(plan.planId, plan)
  rememberFold(input.groupKey, body)
  return plan
}

export function applyFoldIntoExisting(planId: string, ack = false): FoldIntoExistingResult | { error: string; detail?: unknown } {
  const started = Date.now()
  const plan = plans.get(planId)
  if (!plan || !plan.existing) return { error: 'plan-unknown', detail: planId }
  if (plan.blockers.length && ack !== true) return { error: 'plan-blocked', detail: plan.blockers }

  for (const member of plan.members) {
    if (!existsSync(member.path)) return { error: 'member-vanished', detail: member.path }
    if (hashOfPackage(member.path) !== member.hash) {
      return { error: 'plan-stale', detail: { path: member.path, expected: member.hash, found: hashOfPackage(member.path) } }
    }
  }
  const before = hashOfPackage(plan.directory)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.join(DATA_DIR, 'consolidate-trash', `merge-into_${path.basename(plan.directory)}`, stamp)
  mkdirSync(path.dirname(backup), { recursive: true })
  cpSync(plan.directory, backup, { recursive: true })

  const trashed: FoldIntoExistingResult['trashed'] = []
  try {
    for (const entry of plan.carriedFiles) {
      const member = entry.from.split('/')[0]
      const relative = entry.from.slice(member.length + 1)
      const source = path.join(plan.members.find((row) => row.name === member)?.path ?? '', relative)
      if (!existsSync(source)) continue
      const at = path.join(plan.directory, entry.to)
      mkdirSync(path.dirname(at), { recursive: true })
      cpSync(source, at, { recursive: true })
    }
    writeFileSync(path.join(plan.directory, 'SKILL.md'), `${plan.frontmatter}\n${plan.body}\n`, 'utf8')

    for (const member of plan.members) {
      const row = getDb().prepare('SELECT id FROM skills WHERE path = ? OR real_path = ?').get(member.path, member.path) as { id: number } | undefined
      const archived = row ? archiveSkill(row.id, 'consolidate-into-existing') : { ok: false, trashId: undefined }
      trashed.push({ name: member.name, path: member.path, trashId: 'trashId' in archived ? (archived.trashId ?? null) : null })
      if (!('ok' in archived) || archived.ok !== true) {
        throw new Error(`could not move ${member.name}: ${'reason' in archived ? archived.reason : 'unknown'}`)
      }
    }
    for (const member of plan.members) removeByPath(member.path)

    const hash = hashOfPackage(plan.directory)
    const journalId = addJournal('consolidate-into-existing', {
      planId: plan.planId,
      groupKey: plan.groupKey,
      name: plan.name,
      directory: plan.directory,
      backup,
      hashBefore: before,
      hash,
      trashed
    })
    plans.delete(planId)
    return {
      applied: true,
      planId,
      name: plan.name,
      directory: plan.directory,
      backup,
      trashed,
      files: snapshotPackage(plan.directory).size,
      hash,
      journalId,
      ms: Date.now() - started
    }
  } catch (error) {
    // Put the target back byte for byte, then bring every source back out of the trash.
    rmSync(plan.directory, { recursive: true, force: true })
    cpSync(backup, plan.directory, { recursive: true })
    for (const entry of trashed) if (entry.trashId) restoreTrash(entry.trashId)
    return { error: 'apply-failed', detail: { message: (error as Error).message, restored: trashed.map((entry) => entry.name) } }
  }
}

export function undoFoldIntoExisting(journalId: number): { restored: boolean; directory: string; members: string[]; hash: string } | { error: string; detail?: unknown } {
  const row = getDb().prepare('SELECT payload FROM journal WHERE id = ?').get(journalId) as { payload: string } | undefined
  if (!row) return { error: 'journal-unknown', detail: journalId }
  const payload = JSON.parse(row.payload) as {
    directory: string
    backup: string
    trashed?: Array<{ name: string; trashId: number | null }>
  }
  if (!existsSync(payload.backup)) return { error: 'backup-missing', detail: payload.backup }
  rmSync(payload.directory, { recursive: true, force: true })
  cpSync(payload.backup, payload.directory, { recursive: true })
  const members: string[] = []
  for (const entry of payload.trashed ?? []) {
    if (entry.trashId && restoreTrash(entry.trashId)) members.push(entry.name)
  }
  return { restored: true, directory: payload.directory, members, hash: hashOfPackage(payload.directory) }
}
