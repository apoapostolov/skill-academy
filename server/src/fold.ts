import { cpSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { bodyOf, consolidateDryRun } from './consolidate'
import type { Body } from './consolidate'
import { chat, providerById } from './providers'
import { sweepReferences } from './sweep'
import { insideProtected } from './safety'

/**
 * The fold pass: a model reads both bodies and writes one, and then the result is audited against
 * the sources before it is offered.
 *
 * The audit is the point. A model merge is only worth having if a reader can see that nothing was
 * lost, so every rule line from every source is checked for presence in the output, and anything
 * the model wrote that exists in neither source is reported as invented. A single dropped rule
 * makes the proposal `lossy` and unappliable. Nothing here writes; applying is a separate call.
 */

export interface FoldProposal {
  key: string
  /** `merge` folds two copies into one body; `router` rewrites one body to point at the canonical. */
  mode: 'merge' | 'router'
  survivor: string
  model: string
  ms: number
  chars: number
  keptRules: number
  totalRules: number
  droppedRules: string[]
  inventedLines: string[]
  status: 'clean' | 'lossy' | 'error'
  message?: string
  text: string
}

function frontmatterBlock(text: string): string {
  const match = /^(---\r?\n[\s\S]*?\r?\n---)/.exec(text)
  return match ? match[1] : ''
}

function normalize(line: string): string {
  return line
    .toLowerCase()
    .replace(/^[-*#>\s]+/, '')
    .replace(/[`*_“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Rules, headings and every other line with substance, as the audit's comparison set. */
function substantive(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 18)
    .map(normalize)
    .filter(Boolean)
}

function bodyText(dir: string): string {
  const source = readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  const fm = frontmatterBlock(source)
  return source.slice(fm.length)
}

export async function foldGroup(
  key: string,
  providerId: string,
  model: string,
  /** When supplied, this body is audited instead of asking the model again. */
  supplied?: string
): Promise<FoldProposal | { error: string; detail?: unknown }> {
  const run = consolidateDryRun()
  const group = run.groups.find((entry) => entry.key === key)
  if (!group) return { error: 'group-not-found', detail: { key } }
  if (!group.plan) return { error: 'not-applicable', detail: { reason: group.blocked ?? 'no plan' } }

  const provider = providerById(providerId)
  if (!provider) return { error: 'unknown-provider', detail: { providerId } }

  const survivorMember = group.members.find((member) => member.name === group.plan!.survivor)
  if (!survivorMember) return { error: 'survivor-missing', detail: { survivor: group.plan.survivor } }
  const survivor: Body | null = bodyOf(survivorMember.path)
  if (!survivor) return { error: 'survivor-missing', detail: { path: survivorMember.path } }

  const others = group.members.filter((member) => member.name !== survivor.name)
  const sourceBodies = others.map((member) => ({ member, body: bodyOf(member.path) })).filter((entry) => entry.body)

  const survivorText = bodyText(survivor.dir)
  const otherTexts = sourceBodies.map((entry) => bodyText(entry.body!.dir))

  const routerMode = group.plan.routerize.length > 0
  const routerTarget = group.plan.routerize[0]?.name ?? others[0]?.name ?? 'this skill'

  const system = routerMode
    ? [
        'You rewrite one skill body as a router. Output only the finished markdown body, with no frontmatter and no commentary.',
        'The canonical skill is ' + survivor.name + '; the router body belongs to ' + routerTarget + '.',
        'Open with a line telling the reader to load the canonical skill first.',
        'Keep every rule, caveat and exact token this body carries. Never invent a rule, a path, a command or a number.',
        'Keep each unique section under its own heading.',
        'Prefer short, plain sentences. Do not add praise, motivation or filler.'
      ].join(' ')
    : [
    'You merge skill documents. Output only the finished markdown body, with no frontmatter and no commentary.',
    'Keep every rule, caveat and exact token from both inputs. Never invent a rule, a path, a command or a number.',
    'When two rules say the same thing, keep the more specific wording once.',
    'Keep the section headings that carry unique content from either input.',
    'Prefer short, plain sentences. Do not add praise, motivation or filler.'
  ].join(' ')

  // A router is audited against the body it replaces, never against the canonical skill.
  const routerSource = routerMode ? otherTexts[0] ?? '' : ''
  const user = routerMode
    ? ['Body to turn into a router (' + routerTarget + '):', '', routerSource].join('\n')
    : [
    `Canonical body (${survivor.name}):`,
    '',
    survivorText,
    '',
    ...sourceBodies.flatMap((entry) => [`Second copy (${entry.member.name}):`, '', bodyText(entry.body!.dir), ''])
  ].join('\n')

  const generated = supplied
    ? { text: supplied }
    : await chat(provider, { system, user, model, temperature: 0.1, maxTokens: 4000, timeoutMs: 90_000 })
  if ('kind' in generated) {
    const message = generated.kind === 'http' ? `HTTP ${generated.status}: ${generated.body.slice(0, 200)}` : generated.kind === 'no-key' ? 'no key saved' : generated.message
    return { error: 'provider-failed', detail: { message } }
  }

  const text = generated.text.trim().replace(/^```(?:markdown)?\n/, '').replace(/\n```$/, '')
  if (!text) return { error: 'empty-answer', detail: { model } }

  // Audit: nothing from either source may vanish, and anything new is named.
  const sources = (routerMode ? [routerSource] : [survivorText, ...otherTexts]).flatMap(substantive)
  const output = substantive(text)
  const outputSet = new Set(output)
  const dropped = [...new Set(sources)].filter((line) => !outputSet.has(line))
  const sourceSet = new Set(sources)
  const invented = output.filter((line) => !sourceSet.has(line))

  const proposal: FoldProposal = {
    key,
    mode: routerMode ? 'router' : 'merge',
    survivor: survivor.name,
    model,
    ms: supplied ? 0 : ('ms' in generated ? generated.ms : 0),
    chars: text.length,
    keptRules: sources.length - dropped.length,
    totalRules: sources.length,
    droppedRules: dropped.slice(0, 40),
    inventedLines: invented.slice(0, 40),
    status: dropped.length === 0 ? 'clean' : 'lossy',
    text
  }
  if (dropped.length) proposal.message = `${dropped.length} line(s) from the sources are missing from the merge`
  return proposal
}

/**
 * Writing a fold. The gate is deliberate: a model merge is only written when the caller confirms
 * the proposal was read, the audit came back clean, and every replaced body has been archived.
 * `dryRun` runs the whole path and writes nothing, which is how the writer is tested.
 */
export async function applyFold(input: {
  key: string
  provider: string
  model: string
  read: boolean
  confirm: boolean
  dryRun: boolean
  /** The exact body that was read in the panel. What was read is what gets written. */
  text?: string
}): Promise<Record<string, unknown>> {
  const { archiveFile, pointerText, writeBody } = await import('./consolidateApply')
  const proposal = input.text
    ? await foldGroup(input.key, input.provider, input.model, input.text)
    : await foldGroup(input.key, input.provider, input.model)
  if ('error' in proposal) return { error: proposal.error, detail: proposal.detail }
  if (proposal.status !== 'clean') {
    return { error: 'lossy-merge', detail: { dropped: proposal.droppedRules.length, sample: proposal.droppedRules.slice(0, 5) } }
  }
  if (!input.read) return { error: 'read-the-merge', detail: 'confirm the merged body was read before writing' }
  if (!input.confirm) return { error: 'confirmation-required', detail: 'send confirm: true to write it' }

  const run = consolidateDryRun()
  const group = run.groups.find((entry) => entry.key === input.key)
  if (!group?.plan) return { error: 'not-applicable' }

  const survivorMember = group.members.find((member) => member.name === group.plan!.survivor)
  if (!survivorMember) return { error: 'survivor-missing' }
  const survivorBody = bodyOf(survivorMember.path)
  if (!survivorBody) return { error: 'survivor-missing' }

  const file = path.join(survivorBody.dir, 'SKILL.md')
  const guarded = insideProtected([file, ...group.members.map((member) => member.path)])
  if (guarded && !input.dryRun) {
    return { error: 'protected-root', detail: { path: guarded, hint: 'run scripts/fixture-check.sh, or set SKILL_ACADEMY_ALLOW_REAL=1 for a deliberate real merge' } }
  }
  const source = readFileSync(file, 'utf8')
  const fm = frontmatterBlock(source)
  const merged = `${fm}\n\n${proposal.text}\n`

  if (input.dryRun) {
    return {
      dryRun: true,
      wouldWrite: file,
      chars: merged.length,
      survivor: survivorBody.name,
      // Copies of one skill share a name, so the survivor is excluded by path, never by name.
      pointerize: group.members
        .filter((member) => path.resolve(member.path) !== path.resolve(survivorBody.dir))
        .map((member) => member.path),
      audit: { keptRules: proposal.keptRules, totalRules: proposal.totalRules, invented: proposal.inventedLines.length }
    }
  }

  const archive = archiveFile(file, `fold:${input.key}`)
  writeBody(file, merged)

  // The other copies hold nothing the survivor lacks now. A differently named copy becomes a
  // pointer; a copy that shares the survivor's name cannot point anywhere meaningful, so its body
  // is archived and the duplicate is removed rather than left as a self-reference.
  const pointers: Array<{ path: string; archive: string }> = []
  const removed: Array<{ path: string; archive: string }> = []
  for (const member of group.members) {
    if (path.resolve(member.path) === path.resolve(survivorBody.dir)) continue
    const other = bodyOf(member.path)
    if (!other) continue
    const otherFile = path.join(other.dir, 'SKILL.md')
    const otherArchive = archiveFile(otherFile, `fold-duplicate:${input.key}`)
    if (other.name === survivorBody.name) {
      // The support files belong to the removed copy too, so the whole package is preserved in the
      // trash beside the SKILL.md before the directory goes.
      const kept = path.join(path.dirname(otherArchive), 'files')
      cpSync(other.dir, kept, { recursive: true, force: true })
      rmSync(other.dir, { recursive: true, force: true })
      removed.push({ path: otherFile, archive: otherArchive })
    } else {
      writeBody(otherFile, pointerText(other, survivorBody))
      pointers.push({ path: otherFile, archive: otherArchive })
    }
  }

  const roots = (await import('./db')).getDb()
    .prepare('SELECT DISTINCT root_path FROM skills')
    .all() as Array<{ root_path: string }>
  const sweep = sweepReferences(
    roots.map((row) => row.root_path),
    [...pointers, ...removed].map((entry) => path.basename(path.dirname(entry.path))),
    survivorBody.name,
    [survivorBody.dir, ...pointers.map((entry) => path.dirname(entry.path))],
    [survivorBody.dir, ...pointers.map((entry) => path.dirname(entry.path))]
  )

  return {
    applied: true,
    survivor: survivorBody.name,
    archive,
    pointers,
    removed,
    chars: merged.length,
    rewire: { files: sweep.rewired.length, occurrences: sweep.rewired.reduce((sum, hit) => sum + hit.occurrences, 0), dangling: sweep.dangling.length },
    audit: { keptRules: proposal.keptRules, totalRules: proposal.totalRules, invented: proposal.inventedLines.length }
  }
}
