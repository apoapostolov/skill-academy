import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb, addJournal, getSkill } from './db'
import { archiveSkill } from './lifecycle'
import { compareVersions } from './provenance'
import { readBody } from './links'
import { insideProtected } from './safety'
import { chat, providerById } from './providers'
import { loadRegistry } from './registry'
import { diffPackages, normaliseLine, snapshotPackage, substantiveLines, kindOf } from './plandiff'
import type { PackageDiff } from './plandiff'

/**
 * Promote: an older copy of a skill gives way to a newer one without losing what the older one
 * learned on its own. Drift is read first, carried by default, and every carried line is named.
 */

export interface CopyInfo {
  id: number | null
  path: string
  name: string
  version: string | null
  hash: string
  root: string
  scope: string
  mtime: string
  description: string
}

export interface FrontmatterDrift {
  field: string
  loser: string
  winner: string
  resolution: string
}

export interface PlacementOutcome {
  root: string
  scope: string
  name: string
  path: string
  kind: 'directory' | 'symlink' | 'other'
  /** True when this root holds a copy that the plan sends to the trash. */
  loses: boolean
}

/**
 * A merge moves bytes between agent roots without moving the roots themselves, so the plan says,
 * per root, which copy it holds and whether that copy is the one leaving. A root whose only copy is
 * a loser stops seeing the skill unless a link is written there.
 */
export function placementPreview(copies: Array<{ name: string; path: string }>, losers: string[]): PlacementOutcome[] {
  const registry = loadRegistry()
  const losing = new Set(losers.map((entry) => path.resolve(entry).toLowerCase()))
  const rows: PlacementOutcome[] = []
  for (const copy of copies) {
    const at = path.resolve(copy.path)
    // The copy already knows where it lives; the root is the longest registered path that contains it.
    const owner = registry.roots
      .filter((root) => at.toLowerCase().startsWith(path.resolve(root.path).toLowerCase() + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!owner) continue
    let kind: PlacementOutcome['kind'] = 'other'
    try {
      const stat = lstatSync(at)
      kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other'
    } catch {
      continue
    }
    rows.push({
      root: owner.path,
      scope: owner.scope,
      name: copy.name,
      path: at,
      kind,
      loses: losing.has(at.toLowerCase())
    })
  }
  return rows
}

export interface PromotePlan {
  planId: string
  key: string
  winner: CopyInfo
  loser: CopyInfo
  drift: {
    lines: Array<{ text: string; carriedByDefault: boolean }>
    files: Array<{ path: string; kind: string; bytes: number }>
  }
  moved: Array<{ text: string; where: string }>
  frontmatter: FrontmatterDrift[]
  contradictions: Array<{ local: string; upstream: string; why?: string }>
  reverted: boolean
  requiresAck: string[]
  diff: PackageDiff
  placements: PlacementOutcome[]
  carriedHeading: string
  blockers: string[]
  model: string | null
  ms: number
}

const plans = new Map<string, PromotePlan>()

function packageHashOf(dir: string): string {
  const files = snapshotPackage(dir)
  const parts = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => `${name}:${file.hash}`)
  return randomUUID().slice(0, 0) + hashOf(parts.join('|'))
}

function hashOf(text: string): string {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(16).padStart(12, '0')
}

function versionOf(dir: string): string | null {
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  const match = /^version:\s*["']?([^"'\n]+)["']?\s*$/m.exec(readFileSync(file, 'utf8').slice(0, 4000))
  return match ? match[1].trim() : null
}

function descriptionOf(dir: string): string {
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return ''
  const match = /^description:\s*(.*)$/m.exec(readFileSync(file, 'utf8').slice(0, 4000))
  return match ? match[1].trim() : ''
}

function tagsOf(dir: string): string[] {
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8').slice(0, 4000)
  const inline = /^tags:\s*\[(.*)\]\s*$/m.exec(text)
  if (inline) {
    return inline[1]
      .split(',')
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  const block = /^tags:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/m.exec(text)
  if (!block) return []
  return block[1]
    .split('\n')
    .map((line) => line.replace(/^[ \t]*-[ \t]*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

function copyInfo(dir: string): CopyInfo | null {
  if (!existsSync(path.join(dir, 'SKILL.md'))) return null
  const row = getDb().prepare('SELECT id, name, root_path, scope, mtime FROM skills WHERE path = ? OR real_path = ?').get(dir, dir) as
    | { id: number; name: string; root_path: string; scope: string; mtime: string }
    | undefined
  return {
    id: row?.id ?? null,
    path: dir,
    name: row?.name ?? path.basename(dir),
    version: versionOf(dir),
    hash: packageHashOf(dir),
    root: row?.root_path ?? path.dirname(path.dirname(dir)),
    scope: row?.scope ?? 'agent',
    mtime: row?.mtime ?? '',
    description: descriptionOf(dir)
  }
}

/** Every prose file in a package, so a rule that moved into a reference is not called lost. */
function proseCorpus(dir: string): string {
  return [...snapshotPackage(dir).entries()]
    .filter(([, file]) => file.text !== null)
    .map(([, file]) => file.text as string)
    .join('\n')
}

export interface PromoteInput {
  /** Two directories, already chosen by the caller from a group. */
  winnerPath: string
  loserPath: string
  provider?: string
  model?: string
  /** Ask a model whether carried rules contradict the newer body. Costs a call; off by default. */
  contradictions?: boolean
}

export async function planPromote(input: PromoteInput): Promise<PromotePlan | { error: string; detail?: unknown }> {
  const started = Date.now()
  const winner = copyInfo(input.winnerPath)
  const loser = copyInfo(input.loserPath)
  if (!winner) return { error: 'winner-missing', detail: input.winnerPath }
  if (!loser) return { error: 'loser-missing', detail: input.loserPath }
  if (winner.path === loser.path) return { error: 'same-copy', detail: input.winnerPath }

  const blockers: string[] = []
  const protectedWinner = insideProtected([winner.path])
  const protectedLoser = insideProtected([loser.path])
  if (protectedWinner) blockers.push(`the winner is in a protected root: ${protectedWinner}`)
  if (protectedLoser) blockers.push(`the loser is in a protected root: ${protectedLoser}`)
  if (winner.hash === loser.hash) blockers.push('the two copies hold the same bytes; there is nothing to promote')

  const winnerCorpus = proseCorpus(winner.path)
  const winnerNormalised = new Set(substantiveLines(winnerCorpus).map(normaliseLine))
  const loserBody = readBody(loser.path).replace(/\s+$/, '')
  const loserLines = loserBody.split('\n')

  // Lines under a `From <source>` heading belong to a link, not to the user: not organic drift.
  const ingestedRanges: Array<{ start: number; end: number }> = []
  loserLines.forEach((line, index) => {
    if (/^##\s+From\s+/i.test(line.trim())) {
      let end = loserLines.length
      for (let probe = index + 1; probe < loserLines.length; probe += 1) {
        if (/^##\s+/.test(loserLines[probe])) {
          end = probe
          break
        }
      }
      ingestedRanges.push({ start: index, end })
    }
  })
  const inIngested = (index: number): boolean => ingestedRanges.some((range) => index >= range.start && index < range.end)

  const drift: PromotePlan['drift']['lines'] = []
  const moved: PromotePlan['moved'] = []
  const seen = new Set<string>()
  loserLines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || inIngested(index)) return
    const normalised = normaliseLine(trimmed)
    if (!normalised || seen.has(normalised)) return
    seen.add(normalised)
    if (winnerNormalised.has(normalised)) return
    // A rule the newer copy moved into a reference file is not drift, it is a move.
    const elsewhere = [...snapshotPackage(winner.path).entries()].find(
      ([name, file]) => name !== 'SKILL.md' && file.text && file.text.toLowerCase().includes(normalised.slice(0, 40))
    )
    if (elsewhere) {
      moved.push({ text: trimmed, where: elsewhere[0] })
      return
    }
    drift.push({ text: trimmed, carriedByDefault: true })
  })

  const winnerFiles = snapshotPackage(winner.path)
  const loserFiles = snapshotPackage(loser.path)
  const missingFiles = [...loserFiles.entries()]
    .filter(([name]) => !winnerFiles.has(name))
    .map(([name, file]) => ({ path: name, kind: kindOf(name), bytes: file.bytes }))

  const frontmatter: FrontmatterDrift[] = []
  const winnerTags = tagsOf(winner.path)
  const loserTags = tagsOf(loser.path)
  const union = [...new Set([...winnerTags, ...loserTags])]
  if (union.length !== winnerTags.length) {
    frontmatter.push({ field: 'tags', loser: loserTags.join(', '), winner: winnerTags.join(', '), resolution: `union: ${union.join(', ')}` })
  }
  if (loser.description && loser.description !== winner.description) {
    const inside = (text: string): boolean => text.length >= 40 && text.length <= 200
    const resolution = !inside(winner.description) && inside(loser.description) ? loser.description : winner.description
    frontmatter.push({ field: 'description', loser: loser.description, winner: winner.description, resolution })
  }
  const reverted = Boolean(winner.version && loser.version && compareVersions(winner.version, loser.version) < 0)

  let contradictions: PromotePlan['contradictions'] = []
  let model: string | null = null
  if (input.contradictions && drift.length) {
    const providerId = input.provider ?? 'opencode-go'
    const provider = providerById(providerId)
    if (provider) {
      model = input.model ?? 'deepseek-v4.1-flash'
      const answer = await chat(provider, {
        system:
          'You compare two versions of one skill. Output only JSON: {"contradictions":[{"local":"...","upstream":"...","why":"..."}]}. Use it only when the newer body states the opposite of a rule the older body states. Never invent a rule. When there is no contradiction return {"contradictions":[]}.',
        user: [
          `Newer body (${winner.name} ${winner.version ?? ''}):`,
          '',
          readBody(winner.path).trim().slice(0, 12_000),
          '',
          `Older body (${loser.name} ${loser.version ?? ''}):`,
          '',
          loserBody.slice(0, 12_000)
        ].join('\n'),
        model,
        temperature: 0.1,
        maxTokens: 1500,
        timeoutMs: 90_000
      })
      if (!('kind' in answer)) {
        const start = answer.text.indexOf('{')
        const end = answer.text.lastIndexOf('}')
        if (start !== -1 && end > start) {
          try {
            const parsed = JSON.parse(answer.text.slice(start, end + 1)) as { contradictions?: PromotePlan['contradictions'] }
            contradictions = (parsed.contradictions ?? []).filter((entry) => entry?.local && entry?.upstream)
          } catch {
            contradictions = []
          }
        }
      }
    }
  }

  const requiresAck: string[] = []
  if (reverted) requiresAck.push(`the newer copy reports ${winner.version} while the older reports ${loser.version}`)
  if (contradictions.length) requiresAck.push(`${contradictions.length} carried rule(s) contradict the newer body`)
  if (missingFiles.length) requiresAck.push(`${missingFiles.length} file(s) exist only in the older copy`)

  const carriedHeading = `## Carried from ${loser.name}${loser.version ? ` ${loser.version}` : ''}`
  const winnerRaw = readFileSync(path.join(winner.path, 'SKILL.md'), 'utf8')
  const winnerBody = readBody(winner.path).replace(/\s+$/, '')
  const carry = drift.map((line) => line.text)
  const proposedBody = carry.length ? `${winnerBody}\n\n${carriedHeading}\n\n${carry.join('\n')}\n` : `${winnerBody}\n`
  const split = winnerRaw.indexOf(winnerBody)
  const proposed = split === -1 ? proposedBody : winnerRaw.slice(0, split) + proposedBody
  const after = new Map<string, string | null>()
  after.set('SKILL.md', proposed)
  for (const file of missingFiles) {
    const content = loserFiles.get(file.path)?.text
    if (content !== null && content !== undefined) after.set(file.path, content)
  }
  const diff = diffPackages(winner.path, { files: after }, { images: true })

  const placements = placementPreview([winner, loser], [loser.path])

  const plan: PromotePlan = {
    planId: randomUUID(),
    key: `promote:${path.basename(winner.path)}~${path.basename(loser.path)}`,
    winner,
    loser,
    drift: { lines: drift, files: missingFiles },
    moved,
    frontmatter,
    contradictions,
    reverted,
    requiresAck,
    diff,
    placements,
    carriedHeading,
    blockers,
    model,
    ms: Date.now() - started
  }
  plans.set(plan.planId, plan)
  return plan
}

export interface PromoteApplyInput {
  planId: string
  /** Lines the user chose not to carry, matched by their normalised text. */
  drop?: string[]
  /** Carried lines the user added by hand. */
  add?: string[]
  ack?: boolean
}

export interface PromoteApplyResult {
  applied: boolean
  planId: string
  winnerPath: string
  loserPath: string
  carried: number
  winnerHashBefore: string
  winnerHashAfter: string
  loserTrashId: number | null
  journalId: number
}

export function applyPromote(input: PromoteApplyInput): PromoteApplyResult | { error: string; detail?: unknown } {
  const plan = plans.get(input.planId)
  if (!plan) return { error: 'plan-unknown', detail: input.planId }
  if (plan.blockers.length) return { error: 'plan-blocked', detail: plan.blockers }
  if (plan.requiresAck.length && input.ack !== true) {
    return { error: 'ack-required', detail: { reasons: plan.requiresAck } }
  }

  const winner = copyInfo(plan.winner.path)
  const loser = copyInfo(plan.loser.path)
  if (!winner || !loser) return { error: 'copy-vanished' }
  if (winner.hash !== plan.winner.hash || loser.hash !== plan.loser.hash) {
    return { error: 'plan-stale', detail: { expected: [plan.winner.hash, plan.loser.hash], found: [winner.hash, loser.hash] } }
  }

  const dropped = new Set((input.drop ?? []).map(normaliseLine))
  const carry = plan.drift.lines
    .map((line) => line.text)
    .filter((text) => !dropped.has(normaliseLine(text)))
    .concat((input.add ?? []).map((line) => line.trim()).filter(Boolean))

  const skillFile = path.join(winner.path, 'SKILL.md')
  const original = readFileSync(skillFile, 'utf8')
  const body = readBody(winner.path).replace(/\s+$/, '')
  const split = original.indexOf(body)
  const head = split === -1 ? '' : original.slice(0, split)

  // Frontmatter follows the plan's resolutions, so the merge is not only about the body.
  let nextHead = head
  for (const field of plan.frontmatter) {
    if (field.field === 'tags' && field.resolution.startsWith('union: ')) {
      const value = field.resolution.slice('union: '.length)
      if (/^tags:\s*\[.*\]\s*$/m.test(nextHead)) nextHead = nextHead.replace(/^tags:\s*\[.*\]\s*$/m, `tags: [${value}]`)
    }
    if (field.field === 'description') {
      if (/^description:\s*.*$/m.test(nextHead)) {
        nextHead = nextHead.replace(/^description:\s*.*$/m, `description: ${field.resolution}`)
      }
    }
  }

  const nextBody = carry.length ? `${body}\n\n${plan.carriedHeading}\n\n${carry.join('\n')}\n` : `${body}\n`
  writeFileSync(skillFile, nextHead + nextBody, 'utf8')

  for (const file of plan.drift.files) {
    const source = path.join(plan.loser.path, file.path)
    const target = path.join(winner.path, file.path)
    if (!existsSync(source) || existsSync(target)) continue
    const content = snapshotPackage(plan.loser.path).get(file.path)
    if (!content) continue
    writeFileSync(target, readFileSync(source))
  }

  const archived = plan.loser.id !== null ? archiveSkill(plan.loser.id, 'promote') : { ok: false, reason: 'no-row' }
  const winnerHashAfter = copyInfo(winner.path)?.hash ?? ''
  const journalId = addJournal('promote', {
    planId: plan.planId,
    winner: plan.winner.path,
    loser: plan.loser.path,
    carried: carry.length,
    dropped: [...dropped],
    winnerHashBefore: plan.winner.hash,
    winnerHashAfter,
    loserTrashId: 'trashId' in archived ? archived.trashId : null
  })
  plans.delete(plan.planId)

  return {
    applied: true,
    planId: plan.planId,
    winnerPath: plan.winner.path,
    loserPath: plan.loser.path,
    carried: carry.length,
    winnerHashBefore: plan.winner.hash,
    winnerHashAfter,
    loserTrashId: 'trashId' in archived ? (archived.trashId ?? null) : null,
    journalId
  }
}

export function planById(planId: string): PromotePlan | undefined {
  return plans.get(planId)
}
