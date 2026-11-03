import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getDb, addJournal } from './db'
import { DATA_DIR } from './config'
import { fetchBlob, fetchTree, githubApi, latestRelease, resolveRef, sha256 } from './monitor'
import { chat, providerById } from './providers'

/**
 * Linked sources: a local skill that keeps absorbing knowledge from remote skills.
 *
 * The engine is read, propose, apply, snapshot, the same shape as the curator, because this is the
 * only write path that puts prose in a skill the user did not type.
 */

export type Track = 'release' | 'commit'
export type IngestMode = 'distill' | 'attach' | 'summarize'
export type LinkState = 'ok' | 'behind' | 'up-to-date' | 'error' | 'paused' | 'local-drift'

export interface LinkRow {
  id: number
  target_path: string
  skill_id: number | null
  repo: string
  source_path: string
  source_name: string
  track: Track
  ref: string | null
  mode: IngestMode
  last_ingest_sha: string | null
  last_ingest_ref: string | null
  last_ingest_hash: string | null
  state: LinkState
  last_checked_at: string | null
  last_error: string | null
  created_at: string
}

export interface IngestRunRow {
  id: number
  target_path: string
  link_id: number | null
  kind: 'bootstrap' | 'delta'
  from_sha: string | null
  to_sha: string | null
  provider: string | null
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  status: 'queued' | 'running' | 'dry' | 'applied' | 'failed' | 'partial' | 'noop' | 'undone'
  added: number | null
  changed: number | null
  conflicts: number | null
  dropped: number | null
  snapshot_path: string | null
  proposal: string | null
  error: string | null
  started_at: string | null
  finished_at: string | null
}

export interface ProposalRule {
  rule: string
  why?: string
}

export interface Conflict {
  local: string
  upstream: string
  why?: string
}

export interface IngestProposal {
  runId: number
  linkId: number
  target: string
  source: string
  repo: string
  mode: IngestMode
  kind: 'bootstrap' | 'delta'
  fromSha: string | null
  toSha: string
  tag: string | null
  head: string
  sameAsLocal: boolean
  added: ProposalRule[]
  changed: ProposalRule[]
  conflicts: Conflict[]
  dropped: Array<{ rule: string; reason: string }>
  referenceFile: string | null
  pointerOnly: boolean
  files: string[]
  chars: number
  model: string | null
  provider: string | null
  tokensIn: number | null
  tokensOut: number | null
  /** The body this proposal was computed against; apply refuses if the file moved. */
  hashBefore: string
  ms: number
  note?: string
}

/* ------------------------------- schema ---------------------------------- */

export function ensureLinkTables(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_links (
      id               INTEGER PRIMARY KEY,
      target_path      TEXT NOT NULL,
      skill_id         INTEGER,
      repo             TEXT NOT NULL,
      source_path      TEXT NOT NULL,
      source_name      TEXT NOT NULL,
      track            TEXT NOT NULL DEFAULT 'commit',
      ref              TEXT,
      mode             TEXT NOT NULL DEFAULT 'distill',
      last_ingest_sha  TEXT,
      last_ingest_ref  TEXT,
      last_ingest_hash TEXT,
      state            TEXT NOT NULL DEFAULT 'ok',
      last_checked_at  TEXT,
      last_error       TEXT,
      created_at       TEXT NOT NULL,
      UNIQUE(target_path, repo, source_path)
    );
    CREATE TABLE IF NOT EXISTS ingest_runs (
      id            INTEGER PRIMARY KEY,
      target_path   TEXT NOT NULL,
      link_id       INTEGER REFERENCES skill_links(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL DEFAULT 'delta',
      from_sha      TEXT,
      to_sha        TEXT,
      provider      TEXT,
      model         TEXT,
      tokens_in     INTEGER,
      tokens_out    INTEGER,
      status        TEXT NOT NULL,
      added         INTEGER,
      changed       INTEGER,
      conflicts     INTEGER,
      dropped       INTEGER,
      snapshot_path TEXT,
      proposal      TEXT,
      error         TEXT,
      started_at    TEXT,
      finished_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS skill_links_target ON skill_links(target_path);
  `)
}

/* ------------------------------- helpers --------------------------------- */

export function slugOf(repo: string): string {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** One hash for a whole package: path and bytes, in a stable order. */
export function packageHash(dir: string): string {
  const hash = createHash('sha256')
  const walk = (base: string, relative: string): void => {
    for (const entry of readdirSync(path.join(base, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        walk(base, rel)
      } else if (entry.isFile()) {
        hash.update(rel.split(path.sep).join('/'))
        hash.update('\0')
        hash.update(readFileSync(path.join(base, rel)))
        hash.update('\0')
      }
    }
  }
  walk(dir, '')
  return hash.digest('hex').slice(0, 16)
}

function frontmatterSplit(source: string): { head: string; body: string } {
  if (!source.startsWith('---')) return { head: '', body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { head: '', body: source }
  const close = source.indexOf('\n', end + 4)
  const cut = close === -1 ? source.length : close + 1
  return { head: source.slice(0, cut), body: source.slice(cut) }
}

export function readBody(dir: string): string {
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return ''
  return frontmatterSplit(readFileSync(file, 'utf8')).body
}

function normaliseRule(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* --------------------------------- links --------------------------------- */

export function listLinks(targetPath: string): LinkRow[] {
  ensureLinkTables()
  return getDb()
    .prepare('SELECT * FROM skill_links WHERE target_path = ? ORDER BY id')
    .all(targetPath) as unknown as LinkRow[]
}

export function linkById(id: number): LinkRow | undefined {
  ensureLinkTables()
  return getDb().prepare('SELECT * FROM skill_links WHERE id = ?').get(id) as unknown as LinkRow | undefined
}

export function isComposite(targetPath: string): boolean {
  ensureLinkTables()
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM skill_links WHERE target_path = ?').get(targetPath) as { n: number }
  return row.n > 0
}

/** Every skill that carries links, for the curator and the consolidation pass to stay off. */
export function compositeTargets(): Set<string> {
  ensureLinkTables()
  const rows = getDb().prepare('SELECT DISTINCT target_path FROM skill_links').all() as unknown as Array<{ target_path: string }>
  return new Set(rows.map((row) => row.target_path))
}

export interface NewLink {
  targetPath: string
  skillId?: number | null
  repo: string
  sourcePath: string
  sourceName?: string
  track?: Track
  ref?: string | null
  mode?: IngestMode
}

export function addLink(input: NewLink): LinkRow | { error: string; detail?: unknown } {
  ensureLinkTables()
  const repo = input.repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: 'bad-repo', detail: repo }
  const sourcePath = input.sourcePath.trim().replace(/^\/+|\/+$/g, '')
  if (!sourcePath) return { error: 'bad-path' }
  try {
    getDb()
      .prepare(
        `INSERT INTO skill_links (target_path, skill_id, repo, source_path, source_name, track, ref, mode, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`
      )
      .run(
        input.targetPath,
        input.skillId ?? null,
        repo,
        sourcePath,
        input.sourceName?.trim() || path.basename(sourcePath),
        input.track ?? 'commit',
        input.ref ?? null,
        input.mode ?? 'distill',
        new Date().toISOString()
      )
    return listLinks(input.targetPath).at(-1)!
  } catch (error) {
    return { error: 'duplicate-link', detail: (error as Error).message }
  }
}

export function updateLink(id: number, patch: { mode?: IngestMode; track?: Track; ref?: string | null; state?: LinkState }): LinkRow | undefined {
  ensureLinkTables()
  const current = linkById(id)
  if (!current) return undefined
  getDb()
    .prepare('UPDATE skill_links SET mode = ?, track = ?, ref = ?, state = ? WHERE id = ?')
    .run(
      patch.mode ?? current.mode,
      patch.track ?? current.track,
      patch.ref === undefined ? current.ref : patch.ref,
      patch.state ?? current.state,
      id
    )
  return linkById(id)
}

export function removeLink(id: number): boolean {
  ensureLinkTables()
  const result = getDb().prepare('DELETE FROM skill_links WHERE id = ?').run(id)
  return result.changes > 0
}

/* ------------------------------ remote state ----------------------------- */

async function remoteHead(link: LinkRow): Promise<{ sha: string; tag: string | null } | { error: string; detail?: unknown }> {
  if (link.track === 'release') {
    const release = await latestRelease(link.repo)
    if (!release.tag) return { error: 'no-release', detail: link.repo }
    return { sha: await resolveRef(link.repo, release.tag), tag: release.tag }
  }
  const sha = await resolveRef(link.repo, link.ref ?? 'HEAD')
  if (!/^[0-9a-f]{40}$/.test(sha)) return { error: 'unresolved-ref', detail: sha }
  return { sha, tag: null }
}

export interface LinkStatus {
  linkId: number
  source: string
  repo: string
  sourcePath: string
  mode: IngestMode
  track: Track
  state: LinkState
  head: string | null
  tag: string | null
  lastIngestSha: string | null
  commitsBehind: number | null
  files: string[]
  error?: string
}

export async function checkLink(id: number): Promise<LinkStatus | { error: string; detail?: unknown }> {
  const link = linkById(id)
  if (!link) return { error: 'not-found', detail: id }
  const head = await remoteHead(link)
  if ('error' in head) {
    getDb().prepare('UPDATE skill_links SET state = ?, last_checked_at = ?, last_error = ? WHERE id = ?').run('error', new Date().toISOString(), head.error, id)
    return { error: head.error, detail: head.detail }
  }
  const last = link.last_ingest_sha
  let commitsBehind: number | null = null
  let files: string[] = []
  if (last && last !== head.sha) {
    const compared = await compareFiles(link.repo, last, head.sha)
    if ('error' in compared) {
      commitsBehind = null
    } else {
      commitsBehind = compared.aheadBy
      files = compared.files.map((file) => file.filename)
    }
  }
  const state: LinkState = !last ? 'ok' : last === head.sha ? 'up-to-date' : 'behind'
  getDb()
    .prepare('UPDATE skill_links SET state = ?, last_checked_at = ?, last_error = NULL WHERE id = ?')
    .run(state, new Date().toISOString(), id)
  return {
    linkId: id,
    source: link.source_name,
    repo: link.repo,
    sourcePath: link.source_path,
    mode: link.mode,
    track: link.track,
    state,
    head: head.sha,
    tag: head.tag,
    lastIngestSha: last,
    commitsBehind,
    files
  }
}

interface ComparedFile {
  filename: string
  status: string
  additions?: number
  deletions?: number
}

async function compareFiles(repo: string, base: string, head: string): Promise<{ aheadBy: number; files: ComparedFile[] } | { error: string }> {
  const response = await githubApi(`https://api.github.com/repos/${repo}/compare/${base}...${head}`)
  if (!response.ok) return { error: `compare ${response.status}` }
  const data = (await response.json()) as { ahead_by?: number; files?: ComparedFile[] }
  return { aheadBy: data.ahead_by ?? 0, files: data.files ?? [] }
}

/* --------------------------- knowledge selection ------------------------- */

const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_CHARS = 60_000

/** Knowledge, not code: markdown and text inside the linked skill, size-capped. */
export function knowledgeFiles(files: Array<{ path: string; blob: string; bytes: number }>, sourcePath: string, includeCode = false): Array<{ path: string; blob: string; bytes: number }> {
  const prefix = sourcePath.replace(/\/+$/, '') + '/'
  return files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
    .filter((file) => file.bytes <= MAX_FILE_BYTES)
    .filter((file) => {
      const ext = path.extname(file.path).toLowerCase()
      if (ext === '.md' || ext === '.txt' || ext === '.mdx') return true
      return includeCode && ['.py', '.sh', '.js', '.ts', '.json', '.yaml', '.yml'].includes(ext)
    })
    .sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)))
}

interface DeltaSource {
  kind: 'bootstrap' | 'delta'
  toSha: string
  tag: string | null
  files: string[]
  contents: Array<{ path: string; text: string }>
  truncated: boolean
}

async function readDelta(link: LinkRow, head: { sha: string; tag: string | null }, files: string[] | null, includeCode: boolean): Promise<DeltaSource> {
  const tree = await fetchTree(link.repo, head.sha)
  const inside = knowledgeFiles(tree.files, link.source_path, includeCode)
  const wanted = files ? inside.filter((file) => files.some((name) => name === `${link.source_path}/${file.path}` || name === file.path || name.startsWith(`${link.source_path}/`))) : inside
  const selected = files && files.length && wanted.length ? wanted : inside
  const contents: Array<{ path: string; text: string }> = []
  let total = 0
  let truncated = false
  for (const file of selected) {
    if (total >= MAX_TOTAL_CHARS) {
      truncated = true
      break
    }
    const text = (await fetchBlob(link.repo, file.blob)) ?? ''
    if (!text) continue
    const room = MAX_TOTAL_CHARS - total
    const slice = text.length > room ? text.slice(0, room) : text
    if (slice.length < text.length) truncated = true
    contents.push({ path: file.path, text: slice })
    total += slice.length
  }
  return {
    kind: link.last_ingest_sha ? 'delta' : 'bootstrap',
    toSha: head.sha,
    tag: head.tag,
    files: contents.map((file) => file.path),
    contents,
    truncated
  }
}

/* -------------------------------- proposal ------------------------------- */

/**
 * A reasoning model can spend the whole output budget before writing a single visible token. When
 * that happens the answer is empty and the token count sits exactly on the cap, so the call is
 * retried with a larger budget rather than being reported as a refusal.
 */
async function askModel(
  provider: NonNullable<ReturnType<typeof providerById>>,
  request: Parameters<typeof chat>[1]
): Promise<Awaited<ReturnType<typeof chat>>> {
  let budget = request.maxTokens ?? 4000
  let last = await chat(provider, { ...request, maxTokens: budget })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ('kind' in last) return last
    const spent = last.outputTokens ?? 0
    const empty = last.text.trim().length === 0
    if (!empty && !(spent >= budget && last.text.trim().length < 40)) return last
    budget = Math.min(budget * 2, 16_000)
    last = await chat(provider, {
      ...request,
      maxTokens: budget,
      system: `${request.system ?? ''} Write the JSON now, before any reasoning text.`.trim()
    })
  }
  return last
}

const SYSTEM = [
  'You fold a remote skill into a local skill. Output only JSON, no prose around it.',
  'Return exactly these keys: added_rules, changed_rules, conflicts, dropped.',
  'added_rules and changed_rules are arrays of objects with "rule" and "why".',
  '"rule" is imperative and states one durable instruction. "why" is one clause, never a sentence of praise.',
  'conflicts is an array of objects with "local", "upstream" and "why": use it only when the upstream rule contradicts a rule the local skill already states.',
  'dropped is an array of objects with "rule" and "reason": use it for anything the local skill already says, or that another link already taught.',
  'Never invent a command, a path, a number or a version. Never add dates, issue numbers or incident narration.',
  'When nothing new survives, return four empty arrays.'
].join(' ')

const DIGEST_SYSTEM = [
  'You summarise a remote skill for a local skill to reference. Output only JSON with one key: digest.',
  '"digest" is markdown: at most 40 lines, imperative where it states rules, no praise, no dates, no issue numbers.',
  'Never invent a command, a path, a number or a version.'
].join(' ')

function bodyWithSections(body: string, sections: string[]): string {
  const trim = body.replace(/\s+$/, '')
  return [trim, '', ...sections].join('\n') + '\n'
}

function ruleLine(rule: ProposalRule): string {
  const text = rule.rule.trim().replace(/^[-*]\s*/, '')
  return rule.why ? `- ${text} — ${rule.why.trim()}` : `- ${text}`
}

export interface PlanInput {
  linkId: number
  provider?: string
  model?: string
  includeCode?: boolean
  /** Test seam: the model answer, already in the contract shape. */
  supplied?: unknown
}

export async function planIngest(input: PlanInput): Promise<IngestProposal | { error: string; detail?: unknown }> {
  ensureLinkTables()
  const link = linkById(input.linkId)
  if (!link) return { error: 'not-found', detail: input.linkId }
  if (!existsSync(path.join(link.target_path, 'SKILL.md'))) return { error: 'target-missing', detail: link.target_path }

  const head = await remoteHead(link)
  if ('error' in head) return head
  if (link.last_ingest_sha && link.last_ingest_sha === head.sha) {
    return { error: 'no-change', detail: { sha: head.sha, note: 'this link already ingested that commit' } }
  }

  const hashBefore = packageHash(link.target_path)
  const body = readBody(link.target_path)
  const tree = await fetchTree(link.repo, head.sha)
  const inside = knowledgeFiles(tree.files, link.source_path, input.includeCode === true)
  if (!inside.length) return { error: 'no-knowledge-files', detail: link.source_path }

  // The delta is what changed since the last ingested commit; a bootstrap is the whole skill.
  let changedNames: string[] | null = null
  let kind: 'bootstrap' | 'delta' = 'bootstrap'
  if (link.last_ingest_sha) {
    const compared = await compareFiles(link.repo, link.last_ingest_sha, head.sha)
    if ('error' in compared) {
      changedNames = null
    } else {
      const touched = compared.files
        .filter((file) => file.filename.startsWith(`${link.source_path.replace(/\/+$/, '')}/`))
        .map((file) => path.basename(file.filename))
      changedNames = touched.length ? touched : ['SKILL.md']
    }
    kind = 'delta'
  }

  const delta = await readDelta(link, head, changedNames, input.includeCode === true)
  const ingested = existsSync(path.join(link.target_path, 'references', 'ingested'))
    ? readdirSync(path.join(link.target_path, 'references', 'ingested')).filter((name) => name.endsWith('.md'))
    : []

  const runId = startRun(link, kind, head.sha, input.provider ?? null, input.model ?? null)

  if (link.mode === 'attach') {
    const proposal = attachProposal(link, delta, body, hashBefore, runId)
    return proposal
  }

  const providerId = input.provider ?? 'opencode-go'
  const provider = providerById(providerId)
  if (!provider) {
    finishRun(runId, 'failed', { error: `unknown provider ${providerId}` })
    return { error: 'unknown-provider', detail: providerId }
  }
  const model = input.model ?? 'deepseek-v4.1-flash'

  const system = link.mode === 'summarize' ? DIGEST_SYSTEM : SYSTEM
  const user = [
    `Local skill body (${path.basename(link.target_path)}):`,
    '',
    body.trim() || '(empty)',
    '',
    ingested.length ? `Already ingested from other links: ${ingested.join(', ')}` : 'Nothing ingested from other links yet.',
    '',
    `Remote skill ${link.repo} at ${delta.toSha.slice(0, 12)}${delta.tag ? ` (${delta.tag})` : ''}, files:`,
    '',
    ...delta.contents.map((file) => [`--- ${file.path} ---`, file.text, ''].join('\n')),
    delta.truncated ? 'Note: the remote material was truncated at the size cap.' : ''
  ].join('\n')

  const started = Date.now()
  const answer = input.supplied !== undefined
    ? { text: JSON.stringify(input.supplied), model, inputTokens: null, outputTokens: null, ms: 0 }
    : await askModel(provider, { system, user, model, temperature: 0.1, maxTokens: 6000, timeoutMs: 180_000 })
  if ('kind' in answer) {
    const message = answer.kind === 'http' ? `HTTP ${answer.status}: ${answer.body.slice(0, 200)}` : answer.kind === 'no-key' ? 'no key saved for this provider' : answer.message
    finishRun(runId, 'failed', { error: message })
    return { error: 'provider-failed', detail: { message } }
  }

  const parsed = parseAnswer(answer.text)
  if ('error' in parsed) {
    // The tokens are the evidence: an empty answer that still spent output tokens is a truncated
    // or reasoning-only reply, not a model that refused.
    const detail = {
      message: parsed.error,
      sample: answer.text.slice(0, 300),
      chars: answer.text.length,
      inTokens: answer.inputTokens,
      outTokens: answer.outputTokens,
      model: answer.model
    }
    finishRun(runId, 'failed', { error: `${parsed.error} (chars ${detail.chars}, out ${detail.outTokens})` })
    return { error: 'bad-answer', detail }
  }

  if (link.mode === 'summarize') {
    const digest = String((parsed.data as { digest?: string }).digest ?? '').trim()
    if (!digest) {
      finishRun(runId, 'failed', { error: 'empty digest' })
      return { error: 'empty-answer', detail: { model } }
    }
    const slug = slugOf(link.repo)
    const referenceFile = `references/ingested/${slug}-digest.md`
    const sections = [`## ${link.source_name} digest`, '', `- Full digest: \`${referenceFile}\``]
    const proposal: IngestProposal = {
      runId,
      linkId: link.id,
      target: link.target_path,
      source: link.source_name,
      repo: link.repo,
      mode: link.mode,
      kind,
      fromSha: link.last_ingest_sha,
      toSha: delta.toSha,
      tag: delta.tag,
      head: head.sha,
      sameAsLocal: false,
      added: [],
      changed: [],
      conflicts: [],
      dropped: [],
      referenceFile,
      pointerOnly: true,
      files: delta.files,
      chars: bodyWithSections(body, sections).length,
      model: answer.model,
      provider: providerId,
      tokensIn: answer.inputTokens,
      tokensOut: answer.outputTokens,
      hashBefore,
      ms: Date.now() - started
    }
    const record = { proposal, digest }
    getDb().prepare('UPDATE ingest_runs SET proposal = ?, tokens_in = ?, tokens_out = ?, status = ? WHERE id = ?')
      .run(JSON.stringify(record), answer.inputTokens, answer.outputTokens, 'dry', runId)
    return proposal
  }

  const answerShape = parsed.data as {
    added_rules?: ProposalRule[]
    changed_rules?: ProposalRule[]
    conflicts?: Conflict[]
    dropped?: Array<{ rule: string; reason: string }>
  }

  const existing = new Set(
    [body, ...ingested.map((name) => {
      const file = path.join(link.target_path, 'references', 'ingested', name)
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    })].flatMap((text) => text.split('\n').map((line) => normaliseRule(line.replace(/^[-*]\s*/, ''))))
      .filter((line) => line.length > 8)
  )

  const kept: { added: ProposalRule[]; changed: ProposalRule[]; dropped: Array<{ rule: string; reason: string }> } = { added: [], changed: [], dropped: [] }
  const seen = new Set<string>()
  for (const rule of [...(answerShape.added_rules ?? []), ...(answerShape.changed_rules ?? [])]) {
    const text = String(rule?.rule ?? '').trim()
    if (!text) continue
    const key = normaliseRule(text)
    if (seen.has(key)) {
      kept.dropped.push({ rule: text, reason: 'the same rule appeared twice in one answer' })
      continue
    }
    seen.add(key)
    if (existing.has(key)) {
      kept.dropped.push({ rule: text, reason: 'the target already states this' })
      continue
    }
    const entry = { rule: text, why: rule.why ? String(rule.why).trim() : undefined }
    if ((answerShape.changed_rules ?? []).includes(rule)) kept.changed.push(entry)
    else kept.added.push(entry)
  }
  for (const drop of answerShape.dropped ?? []) {
    if (drop?.rule) kept.dropped.push({ rule: String(drop.rule), reason: String(drop.reason ?? 'dropped by the model') })
  }
  const conflicts = (answerShape.conflicts ?? [])
    .filter((entry) => entry && entry.local && entry.upstream)
    .map((entry) => ({ local: String(entry.local), upstream: String(entry.upstream), why: entry.why ? String(entry.why) : undefined }))

  const rules = [...kept.added, ...kept.changed]
  if (!rules.length && !conflicts.length) {
    finishRun(runId, 'noop', { added: 0, changed: 0, conflicts: 0, dropped: kept.dropped.length })
    getDb().prepare('UPDATE skill_links SET last_ingest_sha = ?, last_ingest_ref = ?, last_ingest_hash = ?, state = ? WHERE id = ?')
      .run(delta.toSha, delta.tag, hashBefore, 'up-to-date', link.id)
    return { error: 'nothing-new', detail: { sha: delta.toSha, note: 'the remote skill teaches nothing the local one does not already say' } }
  }

  const slug = slugOf(link.repo)
  const heading = `## From ${link.source_name} (${link.repo}@${delta.toSha.slice(0, 8)})`
  const sectionBody = rules.map(ruleLine)
  const growing = bodyWithSections(body, [heading, '', ...sectionBody])
  const pointerOnly = growing.length > 24_000
  const sections = pointerOnly
    ? [heading, '', `- The rules this skill takes from ${link.source_name} are in \`references/ingested/${slug}.md\`.`]
    : [heading, '', ...sectionBody]
  const referenceFile = `references/ingested/${slug}.md`

  const proposal: IngestProposal = {
    runId,
    linkId: link.id,
    target: link.target_path,
    source: link.source_name,
    repo: link.repo,
    mode: link.mode,
    kind,
    fromSha: link.last_ingest_sha,
    toSha: delta.toSha,
    tag: delta.tag,
    head: head.sha,
    sameAsLocal: delta.toSha === hashBefore,
    added: kept.added,
    changed: kept.changed,
    conflicts,
    dropped: kept.dropped,
    referenceFile,
    pointerOnly,
    files: delta.files,
    chars: growing.length,
    model: answer.model,
    provider: providerId,
    tokensIn: answer.inputTokens,
    tokensOut: answer.outputTokens,
    hashBefore,
    ms: Date.now() - started,
    note: pointerOnly ? 'the body would pass 24,000 characters, so the rules went to the reference file' : undefined
  }
  getDb()
    .prepare('UPDATE ingest_runs SET proposal = ?, tokens_in = ?, tokens_out = ?, status = ?, added = ?, changed = ?, conflicts = ?, dropped = ? WHERE id = ?')
    .run(JSON.stringify({ proposal }), answer.inputTokens, answer.outputTokens, 'dry', kept.added.length, kept.changed.length, conflicts.length, kept.dropped.length, runId)
  return proposal
}

function attachProposal(link: LinkRow, delta: DeltaSource, body: string, hashBefore: string, runId: number): IngestProposal {
  const slug = slugOf(link.repo)
  const heading = `## From ${link.source_name} (${link.repo}@${delta.toSha.slice(0, 8)})`
  const sections = [heading, '', `- Files copied to \`references/ingested/${slug}/\`.`]
  const proposal: IngestProposal = {
    runId,
    linkId: link.id,
    target: link.target_path,
    source: link.source_name,
    repo: link.repo,
    mode: 'attach',
    kind: delta.kind,
    fromSha: link.last_ingest_sha,
    toSha: delta.toSha,
    tag: delta.tag,
    head: delta.toSha,
    sameAsLocal: false,
    added: [],
    changed: [],
    conflicts: [],
    dropped: [],
    referenceFile: `references/ingested/${slug}`,
    pointerOnly: true,
    files: delta.files,
    chars: bodyWithSections(body, sections).length,
    model: null,
    provider: null,
    tokensIn: null,
    tokensOut: null,
    hashBefore,
    ms: 0,
    note: 'attach copies the files as they are; no model is asked'
  }
  getDb()
    .prepare('UPDATE ingest_runs SET proposal = ?, status = ?, added = 0, changed = 0, conflicts = 0, dropped = 0 WHERE id = ?')
    .run(JSON.stringify({ proposal, attach: delta.contents }), 'dry', runId)
  return proposal
}

function parseAnswer(text: string): { data: unknown } | { error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?\n/, '').replace(/\n```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return { error: 'the answer held no JSON object' }
  try {
    return { data: JSON.parse(trimmed.slice(start, end + 1)) }
  } catch (error) {
    return { error: `the answer was not valid JSON: ${(error as Error).message}` }
  }
}

/* --------------------------------- runs ---------------------------------- */

function startRun(link: LinkRow, kind: string, toSha: string, provider: string | null, model: string | null): number {
  const info = getDb()
    .prepare(
      `INSERT INTO ingest_runs (target_path, link_id, kind, from_sha, to_sha, provider, model, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(link.target_path, link.id, kind, link.last_ingest_sha, toSha, provider, model, new Date().toISOString())
  return Number(info.lastInsertRowid)
}

function finishRun(id: number, status: string, patch: { error?: string; added?: number; changed?: number; conflicts?: number; dropped?: number } = {}): void {
  getDb()
    .prepare('UPDATE ingest_runs SET status = ?, error = ?, added = ?, changed = ?, conflicts = ?, dropped = ?, finished_at = ? WHERE id = ?')
    .run(status, patch.error ?? null, patch.added ?? null, patch.changed ?? null, patch.conflicts ?? null, patch.dropped ?? null, new Date().toISOString(), id)
}

export function getRun(id: number): IngestRunRow | undefined {
  ensureLinkTables()
  return getDb().prepare('SELECT * FROM ingest_runs WHERE id = ?').get(id) as unknown as IngestRunRow | undefined
}

export function listRuns(targetPath?: string): IngestRunRow[] {
  ensureLinkTables()
  const rows = targetPath
    ? getDb().prepare('SELECT * FROM ingest_runs WHERE target_path = ? ORDER BY id DESC LIMIT 50').all(targetPath)
    : getDb().prepare('SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 50').all()
  return rows as unknown as IngestRunRow[]
}

/* ---------------------------------- apply -------------------------------- */

export interface ApplyResult {
  applied: boolean
  runId: number
  linkId: number
  hashBefore: string
  hashAfter: string
  added: number
  changed: number
  conflicts: number
  dropped: number
  snapshotPath: string
  referenceFile: string | null
  pointerOnly: boolean
}

export function applyIngest(runId: number): ApplyResult | { error: string; detail?: unknown } {
  ensureLinkTables()
  const run = getRun(runId)
  if (!run) return { error: 'not-found', detail: runId }
  if (run.status !== 'dry') return { error: 'not-a-dry-run', detail: run.status }
  const link = run.link_id ? linkById(run.link_id) : undefined
  if (!link) return { error: 'link-missing', detail: run.link_id }

  const stored = JSON.parse(run.proposal ?? '{}') as { proposal?: IngestProposal; attach?: Array<{ path: string; text: string }>; digest?: string }
  const proposal = stored.proposal
  if (!proposal) return { error: 'empty-run' }

  const hashNow = packageHash(link.target_path)
  if (hashNow !== proposal.hashBefore) {
    return { error: 'local-changed', detail: { expected: proposal.hashBefore, found: hashNow, note: 'the skill moved after the dry run; run the ingest again' } }
  }

  const hashBefore = proposal.hashBefore
  const snapshotDir = path.join(DATA_DIR, 'snapshots', 'ingest', String(runId))
  mkdirSync(snapshotDir, { recursive: true })
  const copy = path.join(snapshotDir, path.basename(link.target_path))
  if (!existsSync(copy)) cpSync(link.target_path, copy, { recursive: true })

  const skillFile = path.join(link.target_path, 'SKILL.md')
  const source = readFileSync(skillFile, 'utf8')
  const { head: frontmatter, body } = frontmatterSplit(source)

  const slug = slugOf(link.repo)
  const referenceFile = proposal.mode === 'attach' ? null : proposal.referenceFile
  const rules = [...proposal.added, ...proposal.changed]

  if (proposal.mode === 'attach' && stored.attach) {
    const target = path.join(link.target_path, 'references', 'ingested', slug)
    for (const file of stored.attach) {
      const destination = path.join(target, file.path)
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, file.text, 'utf8')
    }
    writeFileSync(
      path.join(link.target_path, 'references', 'ingested', `${slug}.md`),
      [
        `# ${link.source_name}`,
        '',
        `- Repository: ${link.repo}`,
        `- Path: \`${link.source_path}\``,
        `- Commit: \`${proposal.toSha}\`${proposal.tag ? ` (${proposal.tag})` : ''}`,
        `- Mode: attach, files copied verbatim to \`references/ingested/${slug}/\``,
        '',
        ...proposal.files.map((file) => `- \`${file}\``)
      ].join('\n') + '\n',
      'utf8'
    )
  } else if (proposal.mode === 'summarize' && stored.digest) {
    mkdirSync(path.join(link.target_path, 'references', 'ingested'), { recursive: true })
    writeFileSync(
      path.join(link.target_path, 'references', 'ingested', `${slug}-digest.md`),
      [
        `# ${link.source_name} digest`,
        '',
        `- Repository: ${link.repo}`,
        `- Commit: \`${proposal.toSha}\`${proposal.tag ? ` (${proposal.tag})` : ''}`,
        '',
        stored.digest.trim(),
        ''
      ].join('\n'),
      'utf8'
    )
  } else if (referenceFile) {
    mkdirSync(path.dirname(path.join(link.target_path, referenceFile)), { recursive: true })
    writeFileSync(
      path.join(link.target_path, referenceFile),
      [
        `# ${link.source_name}`,
        '',
        `- Repository: ${link.repo}`,
        `- Path: \`${link.source_path}\``,
        `- Commit: \`${proposal.toSha}\`${proposal.tag ? ` (${proposal.tag})` : ''}`,
        `- Mode: ${proposal.mode}`,
        '',
        ...rules.map(ruleLine),
        ''
      ].join('\n'),
      'utf8'
    )
  }

  const heading = `## From ${link.source_name} (${link.repo}@${proposal.toSha.slice(0, 8)})`
  const sectionBody = proposal.pointerOnly || proposal.mode !== 'distill'
    ? [`- The rules this skill takes from ${link.source_name} are in \`${proposal.referenceFile}\`.`]
    : rules.map(ruleLine)
  const nextBody = bodyWithSections(body, [heading, '', ...sectionBody])
  writeFileSync(skillFile, frontmatter + nextBody, 'utf8')

  const hashAfter = packageHash(link.target_path)
  getDb()
    .prepare(
      `UPDATE skill_links SET last_ingest_sha = ?, last_ingest_ref = ?, last_ingest_hash = ?, state = 'up-to-date', last_error = NULL, last_checked_at = ? WHERE id = ?`
    )
    .run(proposal.toSha, proposal.tag, hashAfter, new Date().toISOString(), link.id)
  getDb()
    .prepare('UPDATE ingest_runs SET status = ?, snapshot_path = ?, finished_at = ?, added = ?, changed = ?, conflicts = ?, dropped = ? WHERE id = ?')
    .run('applied', snapshotDir, new Date().toISOString(), proposal.added.length, proposal.changed.length, proposal.conflicts.length, proposal.dropped.length, runId)
  addJournal('ingest-apply', {
    skillPath: link.target_path,
    runId,
    linkId: link.id,
    repo: link.repo,
    from: proposal.fromSha,
    to: proposal.toSha,
    hashBefore,
    hashAfter,
    snapshotPath: snapshotDir
  })

  return {
    applied: true,
    runId,
    linkId: link.id,
    hashBefore,
    hashAfter,
    added: proposal.added.length,
    changed: proposal.changed.length,
    conflicts: proposal.conflicts.length,
    dropped: proposal.dropped.length,
    snapshotPath: snapshotDir,
    referenceFile: proposal.referenceFile,
    pointerOnly: proposal.pointerOnly
  }
}

export function undoIngest(runId: number): { restored: boolean; hash: string } | { error: string; detail?: unknown } {
  ensureLinkTables()
  const run = getRun(runId)
  if (!run) return { error: 'not-found', detail: runId }
  if (run.status !== 'applied') return { error: 'not-applied', detail: run.status }
  const stored = JSON.parse(run.proposal ?? '{}') as { proposal?: IngestProposal }
  const proposal = stored.proposal
  if (!proposal || !run.snapshot_path) return { error: 'no-snapshot' }
  const copy = path.join(run.snapshot_path, path.basename(run.target_path))
  if (!existsSync(copy)) return { error: 'snapshot-missing', detail: copy }
  rmSync(run.target_path, { recursive: true, force: true })
  cpSync(copy, run.target_path, { recursive: true })
  const hash = packageHash(run.target_path)
  if (hash !== proposal.hashBefore) return { error: 'restore-mismatch', detail: { expected: proposal.hashBefore, found: hash } }
  getDb().prepare('UPDATE ingest_runs SET status = ? WHERE id = ?').run('undone', runId)
  if (run.link_id) {
    getDb()
      .prepare('UPDATE skill_links SET last_ingest_sha = ?, last_ingest_ref = ?, last_ingest_hash = ?, state = ? WHERE id = ?')
      .run(proposal.fromSha, null, proposal.hashBefore, proposal.fromSha ? 'behind' : 'ok', run.link_id)
  }
  addJournal('ingest-undo', { skillPath: run.target_path, runId, hash })
  return { restored: true, hash }
}

/* ------------------------------- overview -------------------------------- */

export interface LinkSummary extends LinkRow {
  fresh?: boolean
}

export function linksOverview(targetPath: string): { links: LinkSummary[]; runs: IngestRunRow[]; composite: boolean } {
  return { links: listLinks(targetPath), runs: listRuns(targetPath), composite: isComposite(targetPath) }
}

export function newRunId(): string {
  return randomUUID()
}
