import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDb, addJournal } from './db'
import { DATA_DIR } from './config'
import { chat, providerById } from './providers'
import { diffPackages, snapshotPackage, substantiveLines, normaliseLine } from './plandiff'
import type { PackageDiff } from './plandiff'

/**
 * Improve as a job: read, analyse, propose, validate, diff. Each step is recorded so a long run is
 * visible while it happens, and the result is a per-file proposal that writes nothing until applied.
 */

export type ImproveStepName = 'read' | 'analyse' | 'propose' | 'validate' | 'diff'
export type ImproveStatus = 'running' | 'ready' | 'applied' | 'failed' | 'cancelled' | 'partial'

export interface ImproveStep {
  name: ImproveStepName
  status: 'running' | 'done' | 'failed' | 'skipped'
  at: string
  ms: number
  note?: string
}

export interface ProposedFile {
  path: string
  status: 'changed' | 'added' | 'removed'
  content: string | null
  why: string
  /** Lines naming a path, command or flag nothing in the package supports. */
  unsupported: string[]
}

export interface ImproveProposal {
  jobId: number
  skillPath: string
  name: string
  instruction: string
  provider: string
  model: string
  status: ImproveStatus
  steps: ImproveStep[]
  files: ProposedFile[]
  diff: PackageDiff
  hashBefore: string
  notes: string[]
  blockers: string[]
  tokens: { input: number | null; out: number | null }
  startedAt: string
  finishedAt: string | null
  error?: string
}

interface JobRow {
  id: number
  skill_path: string
  instruction: string
  provider: string
  model: string
  status: ImproveStatus
  steps: string
  proposal: string | null
  snapshot_path: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export function ensureImproveTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS improve_jobs (
      id            INTEGER PRIMARY KEY,
      skill_path    TEXT NOT NULL,
      instruction   TEXT NOT NULL,
      provider      TEXT NOT NULL,
      model         TEXT NOT NULL,
      status        TEXT NOT NULL,
      steps         TEXT NOT NULL DEFAULT '[]',
      proposal      TEXT,
      snapshot_path TEXT,
      error         TEXT,
      started_at    TEXT NOT NULL,
      finished_at   TEXT
    );
  `)
}

function packageHashOf(dir: string): string {
  return [...snapshotPackage(dir).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, file]) => `${name}:${file.hash}`)
    .join('|')
    .split('')
    .reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) | 0), 7)
    .toString(16)
    .replace('-', '')
}

const running = new Map<number, ImproveProposal>()

function row(jobId: number): JobRow | undefined {
  ensureImproveTables()
  return getDb().prepare('SELECT * FROM improve_jobs WHERE id = ?').get(jobId) as unknown as JobRow | undefined
}

function save(proposal: ImproveProposal): void {
  getDb()
    .prepare('UPDATE improve_jobs SET status = ?, steps = ?, proposal = ?, error = ?, finished_at = ? WHERE id = ?')
    .run(
      proposal.status,
      JSON.stringify(proposal.steps),
      JSON.stringify(proposal),
      proposal.error ?? null,
      proposal.finishedAt,
      proposal.jobId
    )
}

const CONTRACT = [
  'You improve one skill package. Output only JSON, no prose around it.',
  'Return exactly: {"files":[{"path":"<relative path>","content":"<full new file text or null to delete>","why":"<one clause>"}],"notes":["<what a reader should know>"]}.',
  'Only include a file whose text actually changes. Leave every other file out.',
  'Never invent a command, path, flag, version or tool name. If the package does not mention it, do not write it.',
  'Keep the frontmatter valid: name, description and version must survive.',
  'Rules are imperative with one clause of why. No dates, no issue numbers, no incident narration, no praise.',
  'You may not edit a section that starts with "## From " — those are owned by a linked source.'
].join(' ')

function failureText(failure: { kind: string; status?: number; body?: string; message?: string; provider?: string }): string {
  if (failure.kind === 'http') return `HTTP ${failure.status}: ${(failure.body ?? '').slice(0, 160)}`
  if (failure.kind === 'no-key') return `no key saved for ${failure.provider}`
  return failure.message ?? failure.kind
}

function parseJson(text: string): unknown | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Anything backticked as a path, command or flag that the package never mentions. */
export function unsupportedClaims(added: string[], corpus: string): string[] {
  const known = normaliseLine(corpus)
  const findings: string[] = []
  for (const line of added) {
    for (const match of line.matchAll(/`([^`]{2,80})`/g)) {
      const token = match[1].trim()
      if (!token) continue
      const looksLikeReference = /[/\\]|^-{1,2}[a-z]|^[a-z-]+ --[a-z]|\.(sh|py|js|ts|md|json|ya?ml)$/i.test(token)
      if (!looksLikeReference) continue
      const needle = normaliseLine(token)
      if (needle && !known.includes(needle)) findings.push(`${token} on: ${line.trim().slice(0, 120)}`)
    }
  }
  return [...new Set(findings)]
}

export interface StartImproveInput {
  skillPath: string
  instruction: string
  provider?: string
  model?: string
}

export async function startImprove(input: StartImproveInput): Promise<ImproveProposal | { error: string; detail?: unknown }> {
  ensureImproveTables()
  if (!existsSync(path.join(input.skillPath, 'SKILL.md'))) return { error: 'not-a-skill', detail: input.skillPath }
  const providerId = input.provider ?? 'opencode-go'
  const model = input.model ?? 'deepseek-v4.1-flash'
  const provider = providerById(providerId)
  if (!provider) return { error: 'unknown-provider', detail: providerId }

  const steps: ImproveStep[] = []
  const proposal: ImproveProposal = {
    jobId: 0,
    skillPath: input.skillPath,
    name: path.basename(input.skillPath),
    instruction: input.instruction,
    provider: providerId,
    model,
    status: 'running',
    steps,
    files: [],
    diff: diffPackages(input.skillPath, { dir: input.skillPath }),
    hashBefore: packageHashOf(input.skillPath),
    notes: [],
    blockers: [],
    tokens: { input: null, out: null },
    startedAt: new Date().toISOString(),
    finishedAt: null
  }

  const inserted = getDb()
    .prepare(
      `INSERT INTO improve_jobs (skill_path, instruction, provider, model, status, steps, started_at)
       VALUES (?, ?, ?, ?, 'running', '[]', ?)`
    )
    .run(input.skillPath, input.instruction, providerId, model, proposal.startedAt)
  proposal.jobId = Number(inserted.lastInsertRowid)
  running.set(proposal.jobId, proposal)

  void (async () => {
    try {
      // 1. read
      let at = Date.now()
      const files = snapshotPackage(input.skillPath)
      const body = readFileSync(path.join(input.skillPath, 'SKILL.md'), 'utf8')
      steps.push({
        name: 'read',
        status: 'done',
        at: new Date().toISOString(),
        ms: Date.now() - at,
        note: `${files.size} file(s), ${body.length} characters in SKILL.md`
      })
      const corpus = [...files.values()].filter((file) => file.text !== null).map((file) => file.text as string).join('\n')
      const manifest = [...files.keys()].join('\n')

      // 2. analyse — the model says what should change and why, without writing anything yet
      at = Date.now()
      const analysis = await chat(provider, {
        system:
          'You review one skill package and say what should change. Answer in at most six short lines, each a change you would make and the reason. Name nothing the package does not contain. No praise, no restating the instruction.',
        user: [
          `Instruction from the user: ${input.instruction}`,
          '',
          `Package files:\n${manifest}`,
          '',
          'SKILL.md:',
          body.slice(0, 24_000)
        ].join('\n'),
        model,
        temperature: 0.2,
        maxTokens: 900,
        timeoutMs: 120_000
      })
      if ('kind' in analysis) throw new Error(failureText(analysis))
      steps.push({ name: 'analyse', status: 'done', at: new Date().toISOString(), ms: Date.now() - at, note: analysis.text.slice(0, 400) })

      // 3. propose — full new file contents, one entry per changed file
      at = Date.now()
      const proposed = await chat(provider, {
        system: CONTRACT,
        user: [
          `Instruction from the user: ${input.instruction}`,
          '',
          'Your own analysis:',
          analysis.text.trim(),
          '',
          `Package files:\n${manifest}`,
          '',
          '--- SKILL.md ---',
          body.slice(0, 24_000),
          ...[...files.entries()]
            .filter(([name, file]) => name !== 'SKILL.md' && file.text && file.text.length < 8000)
            .map(([name, file]) => `\n--- ${name} ---\n${file.text}`)
        ].join('\n'),
        model,
        temperature: 0.2,
        maxTokens: 6000,
        timeoutMs: 180_000
      })
      if ('kind' in proposed) throw new Error(failureText(proposed))
      proposal.tokens = { input: proposed.inputTokens, out: proposed.outputTokens }
      const parsed = parseJson(proposed.text)
      if (!parsed || typeof parsed !== 'object') throw new Error('the model answered without the JSON contract')
      const shape = parsed as { files?: Array<{ path?: string; content?: string | null; why?: string }>; notes?: string[] }
      steps.push({
        name: 'propose',
        status: 'done',
        at: new Date().toISOString(),
        ms: Date.now() - at,
        note: `${(shape.files ?? []).length} file(s) proposed`
      })

      // 4. validate — frontmatter, linked sections, invented support, and the size of a deletion
      at = Date.now()
      const proposedFiles: ProposedFile[] = []
      for (const entry of shape.files ?? []) {
        const relative = String(entry.path ?? '').replace(/^[/\\]+/, '')
        if (!relative || relative.includes('..')) continue
        const content = entry.content === null ? null : String(entry.content ?? '')
        const before = files.get(relative)?.text ?? null
        if (content !== null && content === before) continue
        if (content !== null) {
          const added = substantiveLines(content)
          const beforeLines = new Set(substantiveLines(before ?? '').map(normaliseLine))
          const fresh = added.filter((line) => !beforeLines.has(normaliseLine(line)))
          if (/^##\s+From\s+/im.test(content) && !/^##\s+From\s+/im.test(before ?? '')) {
            proposal.blockers.push(`${relative} would add a "## From" section, which only an ingest may write`)
          }
          proposedFiles.push({
            path: relative,
            status: before === null ? 'added' : 'changed',
            content,
            why: String(entry.why ?? '').trim(),
            unsupported: unsupportedClaims(fresh, corpus)
          })
        } else {
          proposedFiles.push({ path: relative, status: 'removed', content: null, why: String(entry.why ?? '').trim(), unsupported: [] })
        }
      }
      proposal.notes = (shape.notes ?? []).map((note) => String(note)).filter(Boolean).slice(0, 12)
      proposal.files = proposedFiles

      const skillFile = proposedFiles.find((file) => file.path === 'SKILL.md')
      if (skillFile?.content && !/^---\n[\s\S]*?name:\s*\S+/m.test(skillFile.content)) {
        proposal.blockers.push('the proposed SKILL.md has no name in its frontmatter')
      }
      const beforeBody = substantiveLines(body).length
      const afterBody = skillFile?.content ? substantiveLines(skillFile.content).length : beforeBody
      if (beforeBody && afterBody < beforeBody * 0.8) {
        proposal.notes.push(`this proposal removes ${beforeBody - afterBody} of ${beforeBody} substantive lines`)
      }
      steps.push({
        name: 'validate',
        status: 'done',
        at: new Date().toISOString(),
        ms: Date.now() - at,
        note: `${proposedFiles.length} file(s), ${proposedFiles.reduce((sum, file) => sum + file.unsupported.length, 0)} unsupported line(s), ${proposal.blockers.length} blocker(s)`
      })

      // 5. diff — the proposal shown against the package as it is now
      at = Date.now()
      const after = new Map<string, string | null>()
      for (const file of proposedFiles) after.set(file.path, file.content)
      proposal.diff = diffPackages(input.skillPath, { files: after }, { images: true })
      steps.push({ name: 'diff', status: 'done', at: new Date().toISOString(), ms: Date.now() - at, note: `${proposal.diff.totals.changed} file(s) change` })

      proposal.status = proposedFiles.length ? 'ready' : 'failed'
      if (!proposedFiles.length) proposal.error = 'the job produced no change'
      proposal.finishedAt = new Date().toISOString()
      save(proposal)
    } catch (error) {
      const message = (error as Error).message
      steps.push({ name: 'propose', status: 'failed', at: new Date().toISOString(), ms: 0, note: message })
      proposal.status = 'failed'
      proposal.error = message
      proposal.finishedAt = new Date().toISOString()
      save(proposal)
    } finally {
      running.delete(proposal.jobId)
    }
  })()

  return proposal
}

export function getImproveJob(jobId: number): ImproveProposal | undefined {
  const live = running.get(jobId)
  if (live) return live
  const stored = row(jobId)
  if (!stored?.proposal) return undefined
  try {
    return JSON.parse(stored.proposal) as ImproveProposal
  } catch {
    return undefined
  }
}

export interface ImproveApplyResult {
  applied: boolean
  jobId: number
  files: string[]
  hashBefore: string
  hashAfter: string
  snapshotPath: string
  journalId: number
}

export function applyImprove(jobId: number, paths?: string[]): ImproveApplyResult | { error: string; detail?: unknown } {
  const proposal = getImproveJob(jobId)
  if (!proposal) return { error: 'not-found', detail: jobId }
  if (proposal.status !== 'ready') return { error: 'not-ready', detail: proposal.status }
  if (proposal.blockers.length) return { error: 'has-blockers', detail: proposal.blockers }

  const current = packageHashOf(proposal.skillPath)
  if (current !== proposal.hashBefore) {
    return { error: 'plan-stale', detail: { expected: proposal.hashBefore, found: current, note: 'the package changed after the job ran' } }
  }

  const wanted = paths?.length ? proposal.files.filter((file) => paths.includes(file.path)) : proposal.files
  if (!wanted.length) return { error: 'nothing-selected' }
  if (wanted.some((file) => file.unsupported.length)) {
    return { error: 'unsupported-claims', detail: wanted.flatMap((file) => file.unsupported) }
  }

  const snapshotDir = path.join(DATA_DIR, 'snapshots', 'improve', String(jobId))
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true })
    cpSync(proposal.skillPath, path.join(snapshotDir, path.basename(proposal.skillPath)), { recursive: true })
  }

  for (const file of wanted) {
    const target = path.join(proposal.skillPath, file.path)
    if (file.content === null) {
      rmSync(target, { recursive: true, force: true })
      continue
    }
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf8')
  }

  const hashAfter = packageHashOf(proposal.skillPath)
  const journalId = addJournal('improve-apply', {
    jobId,
    skillPath: proposal.skillPath,
    files: wanted.map((file) => file.path),
    hashBefore: proposal.hashBefore,
    hashAfter,
    snapshotPath: snapshotDir
  })
  getDb().prepare('UPDATE improve_jobs SET status = ?, snapshot_path = ? WHERE id = ?').run('applied', snapshotDir, jobId)
  const stored = row(jobId)
  if (stored?.proposal) {
    const parsed = JSON.parse(stored.proposal) as ImproveProposal
    parsed.status = 'applied'
    save(parsed)
  }
  running.delete(jobId)

  return { applied: true, jobId, files: wanted.map((file) => file.path), hashBefore: proposal.hashBefore, hashAfter, snapshotPath: snapshotDir, journalId }
}

export function undoImprove(jobId: number): { restored: boolean; hash: string } | { error: string; detail?: unknown } {
  const stored = row(jobId)
  if (!stored) return { error: 'not-found', detail: jobId }
  if (stored.status !== 'applied' || !stored.snapshot_path) return { error: 'not-applied', detail: stored.status }
  const copy = path.join(stored.snapshot_path, path.basename(stored.skill_path))
  if (!existsSync(copy)) return { error: 'snapshot-missing', detail: copy }
  rmSync(stored.skill_path, { recursive: true, force: true })
  cpSync(copy, stored.skill_path, { recursive: true })
  const hash = packageHashOf(stored.skill_path)
  getDb().prepare('UPDATE improve_jobs SET status = ? WHERE id = ?').run('undone', jobId)
  const journalId = addJournal('improve-undo', { jobId, skillPath: stored.skill_path, hash })
  return { restored: true, hash, journalId } as { restored: boolean; hash: string }
}

export function listImproveJobs(skillPath?: string): Array<Pick<JobRow, 'id' | 'skill_path' | 'status' | 'model' | 'started_at' | 'finished_at' | 'instruction'>> {
  ensureImproveTables()
  const rows = skillPath
    ? getDb().prepare('SELECT id, skill_path, status, model, started_at, finished_at, instruction FROM improve_jobs WHERE skill_path = ? ORDER BY id DESC LIMIT 20').all(skillPath)
    : getDb().prepare('SELECT id, skill_path, status, model, started_at, finished_at, instruction FROM improve_jobs ORDER BY id DESC LIMIT 20').all()
  return rows as unknown as Array<Pick<JobRow, 'id' | 'skill_path' | 'status' | 'model' | 'started_at' | 'finished_at' | 'instruction'>>
}
