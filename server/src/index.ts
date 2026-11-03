import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import Fastify from 'fastify'
import { API_PORT, APP_VERSION, DATA_DIR, DB_PATH, HOST, LIBRARY_DIR, REPO_ROOT, WATCH_ENABLED } from './config'
import {
  addJournal,
  categoryFacets,
  copiesOfName,
  forceRecheck,
  getSkill,
  listHiddenAgents,
  listPlacements,
  querySkills,
  readRoots,
  recentJournal,
  saveRoot,
  saveScan,
  setAgentHidden,
  setAllAgentVisibility,
  tagFacets,
  tokensByRoot,
  totals,
  savePreset,
  deletePreset,
  listPresets,
  listWorkspaces,
  saveWorkspace,
  deleteWorkspace,  listSources,
  saveSource,
  recordSourceCheck,
  deleteSource,  recordSourceEvent,
  listSourceEvents,
  acknowledgeSourceEvent,  lockRows,  setSourceSkills,
  sourceSkills,  getDb,  archivedByRoot,
  allSkillPaths,
  removeByPath,
  setMutationHook
} from './db'
import {
  archiveSkill,
  expiredTrash,
  listTrash,
  purgeTrash,
  readSettings,
  restoreTrash,
  undoJournal,
  writeSettings
} from './lifecycle'
import { consolidateDryRun } from './consolidate'
import { applyConsolidation, undoConsolidation } from './consolidateApply'
import { applyFold, foldGroup } from './fold'
import { curateDryRun } from './curate'
import { applyPromote, planPromote, planById as promotePlanById } from './promote'
import {
  applyMergeIntoX,
  applyFoldIntoExisting,
  mergeIntoXPlan,
  planFoldIntoExisting,
  planMergeIntoX,
  undoFoldIntoExisting
} from './mergeIntoX'
import { applyImprove, getImproveJob, listImproveJobs, startImprove, undoImprove } from './improveJob'
import { improveDryRun } from './improve'
import { diffPackages } from './plandiff'
import {
  addLink,
  applyIngest,
  checkLink,
  getRun,
  linkById,
  linksOverview,
  listLinks,
  listRuns,
  planIngest,
  removeLink,
  undoIngest,
  updateLink
} from './links'
import { PROVIDERS, cachedModels, providerById, providerSummary, refreshModels, testProvider } from './providers'
import { setOverride } from './providerConfig'
import {
  OAUTH_PROVIDERS,
  completeAuthorizeFlow,
  disconnectOAuth,
  importToken,
  pollDeviceFlow,
  publicOAuthProviders,
  startAuthorizeFlow,
  startDeviceFlow,
  startWatch
} from './oauth'
import { copyDrift, MANIFEST, place, unplace } from './placement'
import { applyChange } from './apply'
import {
  acknowledgeEvents,
  recordInstallation as recordMonitorInstallation,
  applyUpdate,
  checkInstallation,
  ensureMonitorTables,
  exportMonitor,
  fileDiff,
  installationById,
  listEvents,
  listInstallations,
  localDrift,
  monitorOverview,
  packageDiff,
  planUpdate,
  fetchTree,
  repoMeta,
  latestRelease,
  rollbackInstallation,
  runCheck,
  setPin,
  setPolicy,
  subtree,
  resolveRef,
  adoptLibrarySkill,
  unrecordedSkills,
  type AutoPolicy,
  type Channel
} from './monitor'
import { readPackage, readPackageFile, readPackageImageData } from './package'
import { compareVersions, provenanceOf } from './provenance'
import { deleteKey, getKey, keyStatus, setKey } from './secrets'
import { loadRegistry } from './registry'
import { scanAll, scanOne } from './scan'
import {
  createDraft,
  draftDirectory,
  ensureDrafts,
  generateDraft,
  improveDraft,
  listDrafts,
  readDraft,
  saveDraft,
  undoDraftSave,
  validateDraft,
  writeDraft
} from './drafts'
import { readSkillBody } from './skill'
import { RootWatcher, type Change } from './watch'

const startedAt = new Date()
let lastScanAt: string | null = null
let lastEventAt: string | null = null
let lastEvent: { added: number; changed: number; removed: number; root: string } | null = null

interface RequestLine {
  at: string
  method: string
  url: string
  status: number
  ms: number
}

const requests: RequestLine[] = []
const clients = new Set<ServerResponse>()

function broadcast(payload: Record<string, unknown>): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const client of clients) {
    try {
      client.write(frame)
    } catch {
      clients.delete(client)
    }
  }
}

/**
 * Any change in a watched root rescans that root. Links make per-path bookkeeping
 * wrong: the file that changed may be reached through a junction, and the thing that
 * changed may be the placement itself, not the package.
 */
function handleChange(change: Change): void {
  const result = applyChange(change.root, change.paths)
  if (result.added + result.changed + result.removed === 0) return
  lastScanAt = new Date().toISOString()
  lastEventAt = lastScanAt
  lastEvent = { added: result.added, changed: result.changed, removed: result.removed, root: change.root.path }
  broadcast({
    type: 'library',
    root: change.root.path,
    added: result.added,
    changed: result.changed,
    removed: result.removed,
    at: lastScanAt
  })
}


const watcher = new RootWatcher(handleChange)

const TRASH_DIR = path.join(DATA_DIR, 'trash')

/** Re-read one root after a write of our own, and tell the client. */
function rescanRoot(rootPath: string): void {
  const root = loadRegistry().roots.find((entry) => entry.path === rootPath)
  if (!root) return
  saveRoot(scanOne(root))
  lastScanAt = new Date().toISOString()
  broadcast({ type: 'library', root: rootPath, added: 0, changed: 0, removed: 0, at: lastScanAt })
}

/** Rows whose package no longer has a readable SKILL.md. */
function pruneVanished(): number {
  let removed = 0
  for (const row of allSkillPaths()) {
    if (fs.existsSync(path.join(row.path, 'SKILL.md'))) continue
    removed += removeByPath(row.path)
  }
  return removed
}

async function fullScan(): Promise<{ added: number; changed: number; removed: number; ms: number; skills: number }> {
  const registry = loadRegistry()
  if (WATCH_ENABLED) watcher.sync(registry.roots)
  const outcome = await scanAll(registry.roots)
  const result = saveScan(outcome)
  // A scan indexes what exists; it must also retire what stopped existing, or a removed duplicate
  // keeps answering searches forever.
  const vanished = pruneVanished()
  lastScanAt = new Date().toISOString()
  return { ...result, removed: result.removed + vanished, ms: outcome.ms, skills: outcome.skills }
}

const app = Fastify({ logger: false })

// An empty body with a JSON content-type is not an error: DELETE and POST-with-no-payload
// are normal from a fetch client, and Fastify refuses them by default.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
  const text = typeof body === "string" ? body.trim() : ""
  if (!text) {
    done(null, {})
    return
  }
  try {
    done(null, JSON.parse(text))
  } catch (error) {
    done(error as Error, undefined)
  }
})

app.addHook('onResponse', async (request, reply) => {
  requests.unshift({
    at: new Date().toISOString(),
    method: request.method,
    url: request.url,
    status: reply.statusCode,
    ms: Math.round(reply.elapsedTime)
  })
  if (requests.length > 200) requests.pop()
})

app.get('/api/health', async () => ({ ok: true, version: APP_VERSION }))

app.get('/api/state', async () => {
  const registry = loadRegistry()
  return {
    version: APP_VERSION,
    startedAt: startedAt.toISOString(),
    uptimeMs: Date.now() - startedAt.getTime(),
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    registry: {
      rows: registry.rows,
      codes: registry.codes,
      roots: registry.roots.length,
      detected: registry.roots.filter((root) => root.exists).length
    },
    library: totals(),
    watching: watcher.size,
    lastScanAt,
    lastEventAt,
    lastEvent,
    requests: requests.length
  }
})

app.get('/api/roots', async () => {
  const registry = loadRegistry()
  const stored = new Map(readRoots().map((row) => [row.path.toLowerCase(), row]))
  return {
    roots: registry.roots.map((root) => {
      const row = stored.get(root.path.toLowerCase())
      return {
        path: root.path,
        scope: root.scope,
        owners: root.owners,
        origin: root.origin,
        exists: root.exists,
        error: root.error ?? null,
        skillCount: row?.skill_count ?? null,
        lastScanAt: row?.last_scan_at ?? null
      }
    })
  }
})

app.post('/api/scan', async (request) => {
  // force=1 re-runs the health checker over every row, which a checker change requires.
  const force = (request.query as { force?: string } | undefined)?.force === '1'
  if (force) forceRecheck()
  const result = await fullScan()
  broadcast({ type: 'library', root: null, ...result, at: lastScanAt })
  return {
    finishedAt: lastScanAt,
    ms: result.ms,
    skills: result.skills,
    added: result.added,
    changed: result.changed,
    removed: result.removed,
    watching: watcher.size
  }
})

app.get('/api/events', (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  reply.raw.write('retry: 2000\n\n')
  clients.add(reply.raw)
  const ping = setInterval(() => {
    try {
      reply.raw.write(': ping\n\n')
    } catch {
      clients.delete(reply.raw)
    }
  }, 25_000)
  request.raw.on('close', () => {
    clearInterval(ping)
    clients.delete(reply.raw)
  })
})

app.get('/api/skills', async (request) => {
  const params = request.query as Record<string, string | undefined>
  const result = querySkills({
    q: params.q?.trim() || undefined,
    root: params.root || undefined,
    tag: params.tag || undefined,
    category: params.category || undefined,
    status:
      params.status === 'active' || params.status === 'archived' ? params.status : ('all' as const),
    health: params.health === '1',
    limit: params.limit ? Number(params.limit) : undefined,
    offset: params.offset ? Number(params.offset) : undefined
  })
  return {
    total: result.total,
    rows: result.rows.map((row) => ({
      ...row,
      tags: safeJson(row.tags, []),
      health: safeJson(row.health, []),
      ...provenanceOf(row.path, String(row.mtime))
    }))
  }
})

app.get('/api/skills/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const row = getSkill(Number(id))
  if (!row) {
    reply.code(404)
    return { error: 'not found' }
  }
  const self = provenanceOf(row.path, String(row.mtime))
  const copies = copiesOfName(row.name)
    .map((copy) => ({ ...copy, ...provenanceOf(copy.path, copy.mtime) }))
    .filter((copy) => copy.version)
  const newest = copies.sort((a, b) => compareVersions(a.version, b.version)).at(-1)
  // Same version, different bytes: a copy edited in place without a version bump. The
  // version warning cannot see this, so the detail payload names the copies explicitly.
  const selfHash = String((row as { package_hash?: string }).package_hash ?? '')
  const sameVersionDrift = copies
    .filter(
      (copy) =>
        copy.id !== row.id &&
        copy.version === self.version &&
        selfHash !== '' &&
        String((copy as { package_hash?: string }).package_hash ?? '') !== selfHash
    )
    .map((copy) => ({ id: copy.id, path: copy.path, root: copy.root_path, version: copy.version }))
  const drift =
    self.version && newest && newest.id !== row.id && compareVersions(self.version, newest.version) < 0
      ? { thisVersion: self.version, latestVersion: newest.version, latestId: newest.id, latestRoot: newest.root_path }
      : null
  return {
    ...row,
    version: self.version,
    repo: self.repo,
    findings: safeJson(row.findings, []),
    tags: safeJson(row.tags, []),
    health: safeJson(row.health, []),
    body: readSkillBody(row.path),
    package: readPackage(row.path),
    drift,
    sameVersionDrift
  }
})

app.get('/api/skills/:id/file', async (request, reply) => {
  const { id } = request.params as { id: string }
  const { rel } = request.query as { rel?: string }
  const row = getSkill(Number(id))
  if (!row || !rel) {
    reply.code(400)
    return { error: 'id and rel are required' }
  }
  const image = readPackageImageData(row.path, rel)
  if (image.ok) return { name: image.name, rel, image: image.dataUrl }

  const file = readPackageFile(row.path, rel)
  if (!file.ok) {
    reply.code(file.reason === 'outside-package' ? 403 : 404)
    return { error: file.reason }
  }
  return { name: file.name, rel, text: file.text }
})

app.post('/api/reveal', async (request, reply) => {
  const body = request.body as { path?: string } | undefined
  if (!body?.path) {
    reply.code(400)
    return { error: 'path is required' }
  }
  const target = path.resolve(body.path)
  const roots = loadRegistry().roots.filter((root) => root.exists).map((root) => path.resolve(root.path).toLowerCase())
  const inside = roots.some((root) => target.toLowerCase().startsWith(`${root}${path.sep}`))
  if (!inside) {
    reply.code(403)
    return { error: 'outside a known skill root' }
  }
  try {
    spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return { ok: true }
  } catch (error) {
    reply.code(500)
    return { error: (error as Error).message }
  }
})

app.get('/api/facets', async () => {
  const stored = new Map(readRoots().map((row) => [row.path, row]))
  const tokens = tokensByRoot()
  const registry = loadRegistry()

  // One row per agent, never one row per owner list: a shared root is several agents
  // looking at the same directory, not a group with a name made of commas.
  const agents = registry.roots
    .filter((root) => root.exists)
    .flatMap((root) =>
      root.owners.map((agent) => ({
        agent,
        path: root.path,
        origin: root.origin,
        count: tokens[root.path]?.count ?? stored.get(root.path)?.skill_count ?? 0,
        archived: archivedByRoot()[root.path] ?? 0,
        tokens: tokens[root.path]?.tokens ?? 0
      }))
    )
    .sort((a, b) => a.agent.localeCompare(b.agent))

  const uniqueAgents = [...new Map(agents.map((entry) => [entry.agent, entry])).values()]

  return {
    agents: uniqueAgents,
    hidden: listHiddenAgents(),
    tags: tagFacets(),
    categories: categoryFacets(),
    issues: totals().issues
  }
})

app.post('/api/agents/visibility-all', async (request, reply) => {
  const body = request.body as { hidden?: boolean } | undefined
  if (typeof body?.hidden !== 'boolean') {
    reply.code(400)
    return { error: 'hidden must be a boolean' }
  }
  const agents = loadRegistry().roots.filter((root) => root.exists).flatMap((root) => root.owners)
  setAllAgentVisibility([...new Set(agents)], body.hidden)
  return { hiddenAgents: listHiddenAgents() }
})

app.post('/api/agents/:agent/visibility', async (request, reply) => {
  const { agent } = request.params as { agent: string }
  const body = request.body as { hidden?: boolean } | undefined
  if (typeof body?.hidden !== 'boolean') {
    reply.code(400)
    return { error: 'hidden must be a boolean' }
  }
  setAgentHidden(agent, body.hidden)
  return { agent, hidden: body.hidden, hiddenAgents: listHiddenAgents() }
})

app.get('/api/dev/requests', async () => ({ requests }))

app.get('/api/placements', async (request, reply) => {
  const { skillId } = request.query as { skillId?: string }
  const skill = skillId ? getSkill(Number(skillId)) : undefined
  if (!skill) {
    reply.code(400)
    return { error: 'skillId is required' }
  }

  const registry = loadRegistry()
  const stored = listPlacements(skill.id)
  const byRoot = new Map(stored.map((placement) => [placement.rootPath.toLowerCase(), placement]))
  const rows = registry.roots
    .filter((root) => root.exists)
    .flatMap((root) =>
      root.owners.map((agent) => {
        const hit = byRoot.get(root.path.toLowerCase())
        return {
          agent,
          root: root.path,
          target: hit?.targetPath ?? path.join(root.path, path.basename(skill.path)),
          state: hit ? (hit.mode === 'native' ? 'native' : 'on') : 'off',
          mode: hit?.mode ?? null,
          drift:
            hit && hit.mode === 'copy'
              ? copyDrift(skill.path, hit.targetPath)
              : null
        }
      })
    )

  return { skill: { id: skill.id, name: skill.name, path: skill.path }, placements: rows }
})

app.get('/api/presets', async () => ({ presets: listPresets() }))

function lockDocument() {
  const rows = lockRows().map((row) => ({
    name: row.name,
    version: row.version ?? null,
    root: row.root_path,
    hash: row.package_hash ?? null,
    category: row.category ?? null,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : []
  }))
  return { lockVersion: 1, skills: rows }
}

function lockPath(body?: { path?: string }): string {
  return body?.path ?? process.env.SKILL_ACADEMY_LOCK ?? path.join(DATA_DIR, 'skill-academy.lock.json')
}

/**
 * Every mutation rewrites the lock, debounced so a bulk action costs one write rather than fifty.
 * A library that cannot be reproduced from its lock is not backed up, whatever else is.
 */
let lockTimer: ReturnType<typeof setTimeout> | null = null
function queueLockWrite(): void {
  if (lockTimer) return
  lockTimer = setTimeout(() => {
    lockTimer = null
    try {
      const target = lockPath()
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify(lockDocument(), null, 2) + '\n')
    } catch {
      /* a lock that cannot be written must not fail the mutation that changed the library */
    }
  }, 300)
  lockTimer.unref?.()
}
setMutationHook(queueLockWrite)

app.get('/api/lock', async () => lockDocument())

app.post('/api/lock/write', async (request) => {
  const body = (request.body ?? {}) as { path?: string }
  const target = lockPath(body)
  const document = lockDocument()
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(document, null, 2) + '\n')
  return { written: target, skills: document.skills.length }
})

app.post('/api/lock/check', async (request, reply) => {
  // Check compares content, never the timestamp: a lock written a month ago is still correct
  // if nothing changed, and CI must be able to tell those apart.
  const body = (request.body ?? {}) as { path?: string }
  const target = lockPath(body)
  if (!existsSync(target)) {
    reply.code(404)
    return { error: 'no-lockfile', path: target }
  }
  const expected = JSON.parse(readFileSync(target, 'utf8')) as { skills?: Array<Record<string, unknown>> }
  const actual = lockDocument()
  const key = (row: { name: string; root: string }) => `${row.name}@${row.root}`
  const expectedMap = new Map((expected.skills ?? []).map((row) => [key(row as { name: string; root: string }), row]))
  const actualMap = new Map(actual.skills.map((row) => [key(row), row]))

  const added = [...actualMap.keys()].filter((k) => !expectedMap.has(k))
  const removed = [...expectedMap.keys()].filter((k) => !actualMap.has(k))
  const changed = [...actualMap.keys()].filter((k) => {
    const before = expectedMap.get(k)
    const now = actualMap.get(k)
    return before && now && before.hash !== now.hash
  })

  const drifted = added.length + removed.length + changed.length
  if (drifted) reply.code(409)
  return { ok: drifted === 0, path: target, added, removed, changed }
})

app.post('/api/github/key', async (request, reply) => {
  const body = (request.body ?? {}) as { key?: string }
  const key = (body.key ?? '').trim()
  if (!key) {
    reply.code(400)
    return { error: 'token is required' }
  }
  setKey('github', key)
  return { configured: true, hint: `…${key.slice(-4)}`, source: process.env.GITHUB_TOKEN ? 'environment' : 'store' }
})

app.delete('/api/github/key', async () => ({ removed: deleteKey('github'), ...keyStatus('github') }))

app.get('/api/github/status', async () => {
  const token = githubToken()
  if (!token) return { configured: false, source: null, remaining: 0, limit: 60 }
  const response = await fetch('https://api.github.com/rate_limit', { headers: githubHeaders() })
  const payload = response.ok ? ((await response.json()) as { resources?: { core?: { remaining?: number; limit?: number } } }) : null
  return {
    configured: true,
    source: process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? 'environment' : 'store',
    remaining: payload?.resources?.core?.remaining ?? null,
    limit: payload?.resources?.core?.limit ?? null
  }
})

app.post('/api/consolidate/fold/apply', async (request, reply) => {
  const body = (request.body ?? {}) as {
    key?: string
    provider?: string
    model?: string
    read?: boolean
    confirm?: boolean
    dryRun?: boolean
    text?: string
  }
  if (!body.key) {
    reply.code(400)
    return { error: 'key is required' }
  }
  const settings = readSettings()
  const result = await applyFold({
    key: body.key,
    text: typeof body.text === 'string' && body.text.trim() ? body.text : undefined,
    provider: body.provider ?? settings.mergeProvider,
    model: body.model ?? settings.mergeModel,
    read: !!body.read,
    confirm: !!body.confirm,
    dryRun: !!body.dryRun
  })
  const error = typeof result.error === 'string' ? result.error : null
  if (error) {
    reply.code(error === 'group-not-found' ? 404 : error === 'protected-root' ? 403 : error === 'lossy-merge' ? 409 : 428)
  }
  return result
})

app.post('/api/consolidate/fold', async (request, reply) => {
  const body = (request.body ?? {}) as { key?: string; provider?: string; model?: string }
  if (!body.key) {
    reply.code(400)
    return { error: 'key is required' }
  }
  const settings = readSettings()
  const result = await foldGroup(body.key, body.provider ?? settings.mergeProvider, body.model ?? settings.mergeModel)
  if ('error' in result) {
    reply.code(result.error === 'group-not-found' ? 404 : 409)
    return result
  }
  // A lossy merge is returned for reading, and refused by the apply route.
  return result
})

app.post('/api/consolidate/apply', async (request, reply) => {
  const body = (request.body ?? {}) as { key?: string; read?: boolean; confirm?: boolean }
  if (!body.key) {
    reply.code(400)
    return { error: 'key is required' }
  }
  // The skill's own gate: bodies are read end to end before anything is written.
  if (!body.read) {
    reply.code(428)
    return { error: 'read-both-bodies', detail: 'confirm that both bodies were read before applying' }
  }
  if (!body.confirm) {
    reply.code(428)
    return { error: 'confirmation-required', detail: 'send confirm: true to write the merge' }
  }
  const result = applyConsolidation(body.key)
  if ('error' in result) {
    reply.code(result.error === 'group-not-found' ? 404 : result.error === 'protected-root' ? 403 : 409)
    return result
  }
  return result
})

app.post('/api/consolidate/undo', async (request, reply) => {
  const body = (request.body ?? {}) as { archivePath?: string; originalPath?: string }
  if (!body.archivePath || !body.originalPath) {
    reply.code(400)
    return { error: 'archivePath and originalPath are required' }
  }
  return undoConsolidation(body.archivePath, body.originalPath)
})

app.post('/api/consolidate/dry-run', async () => {
  // Read-only. Every group names its merge type and the body evidence behind it, and a router
  // family comes back as intentional-family with no plan at all.
  return consolidateDryRun()
})

app.post('/api/improve/dry-run', async () => {
  // Read-only, and the rule list ships with the report so a finding can be traced to its source.
  return improveDryRun()
})

app.post('/api/curate/dry-run', async () => {
  // Deterministic and read-only: the report names its evidence, so a wrong cluster is arguable.
  return curateDryRun()
})

app.post('/api/providers/:id/base', async (request, reply) => {
  const provider = providerById((request.params as { id: string }).id)
  if (!provider) {
    reply.code(404)
    return { error: 'unknown provider' }
  }
  const body = (request.body ?? {}) as { base?: string }
  const base = (body.base ?? '').trim()
  if (!base) {
    reply.code(400)
    return { error: 'base is required' }
  }
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    reply.code(400)
    return { error: 'base must be a full URL, for example http://127.0.0.1:11434/v1' }
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    reply.code(400)
    return { error: 'base must be http or https' }
  }
  // A saved address is a preference, not a secret, so it lives in a plain file.
  setOverride(provider.id, { base: base.replace(/\/$/, '') })
  return providerSummary(providerById(provider.id)!)
})

app.get('/api/providers/:id/models', async (request, reply) => {
  const provider = providerById((request.params as { id: string }).id)
  if (!provider) {
    reply.code(404)
    return { error: 'unknown provider' }
  }
  const cache = cachedModels(provider.id)
  const wantsFresh = (request.query as { refresh?: string }).refresh === '1'
  if (cache.fresh && !wantsFresh) return { provider: provider.id, models: cache.models, at: cache.at, cached: true }
  const result = await refreshModels(provider)
  if ('error' in result) {
    reply.code(502)
    // A stale list still beats an empty dropdown, so it is returned with the failure.
    return { error: result.error, models: cache.models, at: cache.at, cached: true }
  }
  return { provider: provider.id, models: result.models, at: result.at, cached: false }
})

app.post('/api/providers/:id/models', async (request, reply) => {
  const provider = providerById((request.params as { id: string }).id)
  if (!provider) {
    reply.code(404)
    return { error: 'unknown provider' }
  }
  const result = await refreshModels(provider)
  if ('error' in result) {
    reply.code(502)
    return { error: result.error, base: provider.base }
  }
  return { provider: provider.id, base: provider.base, models: result.models, at: result.at }
})

app.get('/api/oauth', async () => ({ providers: publicOAuthProviders() }))

app.post('/api/oauth/:id/start', async (request, reply) => {
  const id = (request.params as { id: string }).id
  const config = OAUTH_PROVIDERS[id]
  if (!config) {
    reply.code(404)
    return { error: 'no sign-in for that provider' }
  }
  try {
    if (config.kind === 'authorize') return startAuthorizeFlow(id)
    const started = await startDeviceFlow(id)
    // The approval can land long after this dialog closes, so the server keeps polling.
    startWatch(id, started.flowId, started.interval ?? 5)
    return started
  } catch (error) {
    reply.code((error as { status?: number }).status ?? 502)
    return { error: (error as Error).message, code: (error as { code?: string }).code ?? null }
  }
})

app.post('/api/oauth/:id/poll', async (request, reply) => {
  const id = (request.params as { id: string }).id
  const body = (request.body ?? {}) as { flowId?: string }
  if (!body.flowId) {
    reply.code(400)
    return { error: 'flowId is required' }
  }
  try {
    return await pollDeviceFlow(id, body.flowId)
  } catch (error) {
    reply.code((error as { status?: number }).status ?? 502)
    return { error: (error as Error).message }
  }
})

app.post('/api/oauth/:id/complete', async (request, reply) => {
  const id = (request.params as { id: string }).id
  const body = (request.body ?? {}) as { flowId?: string; code?: string }
  try {
    return await completeAuthorizeFlow(id, body.flowId ?? '', body.code ?? '')
  } catch (error) {
    reply.code((error as { status?: number }).status ?? 502)
    return { error: (error as Error).message }
  }
})

app.post('/api/oauth/:id/import', async (request, reply) => {
  const id = (request.params as { id: string }).id
  const body = (request.body ?? {}) as { access?: string; refresh?: string; expiresAt?: string }
  try {
    return importToken(id, body)
  } catch (error) {
    reply.code((error as { status?: number }).status ?? 400)
    return { error: (error as Error).message }
  }
})

app.delete('/api/oauth/:id', async (request) => ({ removed: disconnectOAuth((request.params as { id: string }).id) }))

app.get('/api/providers', async () => ({
  providers: PROVIDERS.map(providerSummary)
}))

app.post('/api/providers/:id/key', async (request, reply) => {
  const provider = providerById((request.params as { id: string }).id)
  if (!provider) {
    reply.code(404)
    return { error: 'unknown provider' }
  }
  const body = (request.body ?? {}) as { key?: string }
  const key = (body.key ?? '').trim()
  if (!key) {
    reply.code(400)
    return { error: 'key is required' }
  }
  try {
    setKey(provider.id, key)
  } catch (error) {
    reply.code(500)
    return { error: (error as Error).message }
  }
  // The key goes in and never comes back out: the response repeats only the masked status.
  return providerSummary(provider)
})

app.delete('/api/providers/:id/key', async (request, reply) => {
  const provider = providerById((request.params as { id: string }).id)
  if (!provider) {
    reply.code(404)
    return { error: 'unknown provider' }
  }
  const removed = deleteKey(provider.id)
  return { removed, ...providerSummary(provider) }
})

app.post('/api/providers/:id/test', async (request, reply) => {
  const provider = providerById((request.params as { id: string }).id)
  if (!provider) {
    reply.code(404)
    return { error: 'unknown provider' }
  }
  const body = (request.body ?? {}) as { model?: string }
  const result = await testProvider(provider, body.model)
  if (!result.ok) reply.code(200)
  return { provider: provider.id, ...result }
})

app.get('/api/sources', async () => ({ sources: listSources() }))

app.post('/api/sources', async (request, reply) => {
  const body = request.body as { repo?: string } | undefined
  const repo = (body?.repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    reply.code(400)
    return { error: 'repo must look like owner/name' }
  }
  return { source: saveSource(repo) }
})

async function checkSource(source: { id: number; repo: string; last_commit: string | null; last_release: string | null; checked_at: string | null }) {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'skill-academy' }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`

  const commitResponse = await fetch(`https://api.github.com/repos/${source.repo}/commits?per_page=1`, { headers })
  if (!commitResponse.ok) return { repo: source.repo, error: `github ${commitResponse.status}` }
  const commits = (await commitResponse.json()) as Array<{ sha?: string }>
  const commit = commits[0]?.sha?.slice(0, 12) ?? null

  let release: string | null = null
  const releaseResponse = await fetch(`https://api.github.com/repos/${source.repo}/releases/latest`, { headers })
  if (releaseResponse.ok) {
    const payload = (await releaseResponse.json()) as { tag_name?: string }
    release = payload.tag_name ?? null
  }

  const seenBefore = source.checked_at !== null
  if (seenBefore && commit && commit !== source.last_commit) recordSourceEvent(source.repo, 'commit', commit)
  if (seenBefore && release && release !== source.last_release) recordSourceEvent(source.repo, 'release', release)
  recordSourceCheck(source.repo, commit, release)
  return {
    repo: source.repo,
    commit,
    release,
    changed: seenBefore && (commit !== source.last_commit || release !== source.last_release),
    previous: { commit: source.last_commit, release: source.last_release }
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let lastPollAt: string | null = null

function pollMinutes(): number {
  const raw = Number(process.env.SKILL_ACADEMY_POLL_MINUTES ?? 30)
  return Number.isFinite(raw) && raw > 0 ? raw : 30
}

async function pollSources(): Promise<{ checked: number; events: number }> {
  let checked = 0
  for (const source of listSources()) {
    try {
      await checkSource(source)
      checked += 1
    } catch {
      /* one repo failing must not stop the sweep */
    }
  }
  lastPollAt = new Date().toISOString()
  return { checked, events: listSourceEvents().length }
}

function startPoller(): void {
  if (process.env.SKILL_ACADEMY_POLL !== '1' || pollTimer) return
  // One timer drives both sweeps: source events first, then the versioning monitor, which is the
  // pass that can act on an auto-update policy.
  pollTimer = setInterval(() => {
    void (async () => {
      await pollSources()
      try {
        await runCheck({})
      } catch (error) {
        console.error('monitor check failed:', (error as Error).message)
      }
    })()
  }, pollMinutes() * 60 * 1000)
  pollTimer.unref?.()
}

app.get('/api/sources/status', async () => ({
  enabled: process.env.SKILL_ACADEMY_POLL === '1',
  minutes: pollMinutes(),
  lastPollAt,
  unacknowledged: listSourceEvents().length
}))

app.post('/api/sources/poll', async () => pollSources())

function frontmatterField(text: string, key: string): string | null {
  const head = text.slice(0, 3000)
  const match = new RegExp(`^${key}:\s*(.*)$`, 'm').exec(head)
  if (!match) return null
  const value = match[1].trim().replace(/^["']|["']$/g, '')
  // A folded or literal block puts the words on the following indented lines.
  if (value === '>' || value === '|' || value === '>-' || value === '|-') {
    const rest = head.slice(match.index + match[0].length).split(/\r?\n/).slice(1)
    const lines: string[] = []
    for (const line of rest) {
      if (!line.trim()) {
        if (lines.length) break
        continue
      }
      if (!/^\s+/.test(line)) break
      lines.push(line.trim())
    }
    return lines.length ? lines.join(' ') : null
  }
  return value || null
}

app.post('/api/install/apply', async (request, reply) => {
  // Two phases: everything downloads into the library first, then placement happens through
  // the same journalled path the switches use. A replaced copy goes to the trash, never away.
  const body = (request.body ?? {}) as { repo?: string; paths?: string[]; agents?: string[]; mode?: 'symlink' | 'copy'; ref?: string }
  const repo = (body.repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '')
  const paths = (body.paths ?? []).map((entry) => entry.replace(/\/+$/, '')).filter(Boolean)
  const agents = body.agents ?? []
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !paths.length || !agents.length) {
    reply.code(400)
    return { error: 'repo, paths and agents are required' }
  }

  const registry = loadRegistry()
  const roots = agents
    .map((agent) => ({ agent, root: registry.roots.find((entry) => entry.exists && entry.owners.includes(agent)) }))
    .filter((entry): entry is { agent: string; root: NonNullable<typeof entry.root> } => Boolean(entry.root))
  const missingRoots = agents.filter((agent) => !roots.some((entry) => entry.agent === agent))

  const policy = (readSettings() as { install_replace_policy?: string }).install_replace_policy ?? 'trash'
  const libraryRoot = LIBRARY_DIR
  mkdirSync(libraryRoot, { recursive: true })
  const ref = body.ref ?? 'HEAD'
  const forceCopy = body.mode === 'copy'

  const results: Array<{ path: string; installed: boolean; replaced?: boolean; error?: string; placements?: unknown[] }> = []
  for (const skillPath of paths) {
    const name = path.basename(skillPath)
    const localDir = path.join(libraryRoot, name)
    if (path.resolve(localDir) === path.resolve(skillPath)) {
      results.push({ path: skillPath, installed: false, error: 'inside-library' })
      continue
    }

    const treeResponse = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, {
      headers: githubHeaders()
    })
    if (!treeResponse.ok) {
      results.push({ path: skillPath, installed: false, error: githubFailure(treeResponse.status) })
      continue
    }
    const tree = (await treeResponse.json()) as { tree?: Array<{ path: string; type: string }> }
    const files = (tree.tree ?? []).filter((entry) => entry.type === 'blob' && entry.path.startsWith(skillPath + '/'))

    let replaced = false
    try {
      if (existsSync(localDir)) {
        if (policy === 'refuse') {
          results.push({ path: skillPath, installed: false, error: 'exists-locally' })
          continue
        }
        unplace(localDir, TRASH_DIR)
        replaced = true
      }
      for (const file of files) {
        const relative = file.path.slice(skillPath.length + 1)
        const target = path.join(localDir, relative)
        const raw = await fetchRaw(repo, ref, file.path)
        if (!raw.ok) continue
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, raw.text)
      }
      const placements = roots.map((entry) => {
        try {
          const placed = place(localDir, entry.root.path, forceCopy ? { forceCopy: true } : {})
          addJournal('place', { agent: entry.agent, target: placed.target, mode: placed.mode, source: `${repo}@${ref}` })
          return { agent: entry.agent, ok: true, mode: placed.mode }
        } catch (error) {
          return { agent: entry.agent, ok: false, error: (error as Error).message }
        }
      })
      addJournal('install', { repo, ref, path: skillPath, name, files: files.length, replaced, mode: body.mode ?? 'symlink' })
      // The baseline is written here, while the bytes are known to be exactly what upstream sent.
      const placedAgents = roots
        .filter((entry) => placements.some((row) => row.agent === entry.agent && row.ok))
        .map((entry) => ({ agent: entry.agent, mode: forceCopy ? 'copy' : 'symlink', targetPath: path.join(entry.root.path, name) }))
      try {
        recordMonitorInstallation({
          repo,
          remotePath: skillPath,
          ref: await resolveRef(repo, ref),
          refKind: 'commit',
          libraryPath: localDir,
          agents: placedAgents
        })
      } catch (error) {
        addJournal('monitor-baseline-failed', { repo, skillPath, error: (error as Error).message })
      }
      results.push({ path: skillPath, installed: true, replaced, placements })
    } catch (error) {
      results.push({ path: skillPath, installed: false, error: (error as Error).message })
    }
  }

  return {
    repo,
    ref,
    mode: body.mode ?? 'symlink',
    policy,
    libraryRoot,
    installed: results.filter((row) => row.installed).length,
    failed: results.filter((row) => !row.installed).length,
    missingRoots,
    results
  }
})

app.post('/api/install/test', async (request, reply) => {
  // Test is read-only on purpose: it says what the repository would install, before anything
  // is downloaded into the library or placed anywhere.
  const body = (request.body ?? {}) as { repo?: string; ref?: string }
  const repo = (body.repo ?? '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/tree\/.*$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    reply.code(400)
    return { error: 'repo must look like owner/name' }
  }
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'skill-academy' }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`

  const ref = body.ref ?? 'HEAD'
  const treeResponse = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { headers })
  if (!treeResponse.ok) {
    reply.code(502)
    return { error: githubFailure(treeResponse.status), repo }
  }
  const tree = (await treeResponse.json()) as { tree?: Array<{ path: string; type: string; size?: number }> }
  const skillFiles = (tree.tree ?? []).filter(
    (entry) => entry.type === 'blob' && /(^|\/)SKILL\.md$/i.test(entry.path)
  )
  if (!skillFiles.length) {
    return { repo, ref, found: 0, skills: [], note: 'No SKILL.md files in this repository.' }
  }

  const skills = []
  for (const entry of skillFiles.slice(0, 60)) {
    const dir = entry.path.replace(/\/SKILL\.md$/i, '')
    const name = dir.split('/').pop() ?? dir
    const siblings = (tree.tree ?? []).filter(
      (other) => other.type === 'blob' && dir && other.path.startsWith(dir + '/')
    )
    let description: string | null = null
    let version: string | null = null
    const raw = await fetchRaw(repo, ref === 'HEAD' ? 'HEAD' : ref, entry.path)
    if (raw.ok) {
      description = frontmatterField(raw.text, 'description')
      version = frontmatterField(raw.text, 'version')
    }
    skills.push({
      path: dir,
      name,
      version,
      description,
      files: siblings.length,
      bytes: siblings.reduce((total, file) => total + (file.size ?? 0), 0)
    })
  }

  return {
    repo,
    ref,
    found: skills.length,
    skills,
    note: 'Selection is what would install. Nothing has been downloaded yet.'
  }
})

function githubToken(): string | null {
  // Environment first, then the credential store: an unauthenticated GitHub allows 60 requests
  // an hour, which a handful of checks spends, and then every call looks broken.
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? getKey('github')
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'skill-academy' }
  const token = githubToken()
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

function githubFailure(status: number): string {
  if (status === 403 || status === 429) {
    return githubToken()
      ? `github ${status}: rate limit reached, wait for the reset hour`
      : `github ${status}: unauthenticated limit reached, save a GitHub token in Settings`
  }
  if (status === 404) return 'github 404: repository not found, or private without a token'
  return `github ${status}`
}

async function fetchRaw(repo: string, ref: string, filePath: string): Promise<{ ok: boolean; text: string; status: number }> {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${filePath.replace(/^\/+/, '')}`
  const response = await fetch(url, { headers: { 'user-agent': 'skill-academy' } })
  if (!response.ok) return { ok: false, text: '', status: response.status }
  return { ok: true, text: await response.text(), status: 200 }
}

app.post('/api/sources/:id/skills', async (request, reply) => {
  const { id } = request.params as { id: string }
  const source = listSources().find((row) => row.id === Number(id))
  if (!source) {
    reply.code(404)
    return { error: 'not found' }
  }
  const body = (request.body ?? {}) as { skills?: string[] }
  const skills = (body.skills ?? []).map((entry) => String(entry).trim()).filter(Boolean)
  setSourceSkills(source.id, skills)
  return { repo: source.repo, skills }
})

const updatePlans = new Map<string, { sourceId: number; commit: string | null; release: string | null; at: string }>()

app.post('/api/sources/:id/plan-update', async (request, reply) => {
  // A plan is what would change and nothing more. It never writes, and it expires, so a stale
  // plan cannot be confirmed later against a source that has moved on.
  const { id } = request.params as { id: string }
  const source = listSources().find((row) => row.id === Number(id))
  if (!source) {
    reply.code(404)
    return { error: 'not found' }
  }
  const fresh = await checkSource(source)
  if ('error' in fresh) {
    reply.code(502)
    return fresh
  }

  const mapped = sourceSkills(source.id)
  const files: Array<{ path: string; status: number; hash: string | null; bytes: number }> = []
  if (mapped.length) {
    const ref = fresh.commit ?? fresh.release ?? 'HEAD'
    for (const filePath of mapped) {
      // A mapping is either a file or a whole skill directory, and a directory answers 404 to a
      // raw file request: ask the tree instead of reporting a misleading status.
      if (!/\.[A-Za-z0-9]+$/.test(filePath)) {
        const treeUrl = `https://api.github.com/repos/${source.repo}/git/trees/${ref}?recursive=1`
        const treeResponse = await fetch(treeUrl, { headers: githubHeaders() })
        const tree = treeResponse.ok
          ? ((await treeResponse.json()) as { tree?: Array<{ path: string; type: string }> }).tree ?? []
          : []
        const inside = tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith(filePath + '/'))
        files.push({ path: filePath, status: treeResponse.ok ? 200 : treeResponse.status, hash: null, bytes: inside.length })
        continue
      }
      const raw = await fetchRaw(source.repo, ref, filePath)
      files.push({
        path: filePath,
        status: raw.status,
        hash: raw.ok ? createHash('sha256').update(raw.text).digest('hex').slice(0, 16) : null,
        bytes: raw.ok ? Buffer.byteLength(raw.text, 'utf8') : 0
      })
    }
  }

  const commitChanged = fresh.commit !== fresh.previous.commit
  const releaseChanged = fresh.release !== fresh.previous.release
  const planId = `${source.id}-${Date.now().toString(36)}`
  updatePlans.set(planId, { sourceId: source.id, commit: fresh.commit ?? null, release: fresh.release ?? null, at: new Date().toISOString() })

  return {
    dryRun: true,
    planId,
    repo: source.repo,
    from: fresh.previous,
    to: { commit: fresh.commit, release: fresh.release },
    changes: [
      ...(commitChanged ? [{ kind: 'commit', from: fresh.previous.commit, to: fresh.commit }] : []),
      ...(releaseChanged ? [{ kind: 'release', from: fresh.previous.release, to: fresh.release }] : [])
    ],
    files,
    affects: [],
    note:
      'Confirming records the decision and journals it. Pulling new skill files needs a repository to library mapping, which is the next step of this phase.'
  }
})

app.post('/api/sources/:id/apply-update', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { planId?: string; confirm?: boolean; replace?: boolean }
  const plan = body.planId ? updatePlans.get(body.planId) : undefined
  if (!plan || plan.sourceId !== Number(id)) {
    reply.code(404)
    return { error: 'plan-not-found' }
  }
  if (body.confirm !== true) {
    reply.code(409)
    return { error: 'confirmation-required', plan }
  }
  updatePlans.delete(body.planId!)

  const source = listSources().find((row) => row.id === Number(id))
  const mapped = source ? sourceSkills(source.id) : []
  const staged: string[] = []
  const replaced: Array<{ name: string; path: string; files: number }> = []
  if (source && mapped.length) {
    const ref = plan.commit ?? plan.release ?? 'HEAD'
    const root = path.join(process.env.HOME ?? process.cwd(), '.skill-academy', 'staging', `${source.id}-${ref.slice(0, 12)}`)
    for (const filePath of mapped) {
      const raw = await fetchRaw(source.repo, ref, filePath)
      if (!raw.ok) continue
      const target = path.join(root, filePath.replace(/^\/+/, ''))
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, raw.text)
      staged.push(target)
    }
    addJournal('source-fetch', { repo: source.repo, ref, staged })

    // Replace takes the same road an install does: the package is rebuilt in the library and any
    // previous copy is moved to the trash first. Placement links point at the library folder, so
    // they keep working after the bytes underneath them change.
    if (body.replace === true) {
      const libraryRoot = LIBRARY_DIR
      for (const skillPath of mapped) {
        if (!skillPath.includes('/')) continue
        const name = path.basename(skillPath.replace(/\/+$/, ''))
        const target = path.join(libraryRoot, name)
        const treeResponse = await fetch(`https://api.github.com/repos/${source.repo}/git/trees/${ref}?recursive=1`, {
          headers: githubHeaders()
        })
        if (!treeResponse.ok) continue
        const tree = (await treeResponse.json()) as { tree?: Array<{ path: string; type: string }> }
        const files = (tree.tree ?? []).filter((entry) => entry.type === 'blob' && entry.path.startsWith(skillPath + '/'))
        if (existsSync(target)) unplace(target, TRASH_DIR)
        for (const file of files) {
          const relative = file.path.slice(skillPath.length + 1)
          const destination = path.join(target, relative)
          const raw = await fetchRaw(source.repo, ref, file.path)
          if (!raw.ok) continue
          mkdirSync(path.dirname(destination), { recursive: true })
          writeFileSync(destination, raw.text)
        }
        replaced.push({ name, path: target, files: files.length })
      }
      addJournal('source-replace', { repo: source.repo, ref, replaced })
    }
  }

  const acknowledged = listSourceEvents().filter((event) => event.repo === listSources().find((row) => row.id === Number(id))?.repo)
  for (const event of acknowledged) acknowledgeSourceEvent(event.id)
  addJournal('source-update', { repo: acknowledged[0]?.repo ?? '', commit: plan.commit, release: plan.release, events: acknowledged.length })

  return {
    applied: true,
    from: plan.at,
    commit: plan.commit,
    release: plan.release,
    acknowledged: acknowledged.length,
    staged,
    replaced,
    note: staged.length
      ? 'Files are staged. Installing them into the library is a separate, reversible step.'
      : 'No mapped files to fetch.'
  }
})

app.post('/api/sources/check-all', async () => {
  const sources = listSources()
  const results = []
  for (const source of sources) {
    try {
      results.push(await checkSource(source))
    } catch (error) {
      results.push({ repo: source.repo, error: (error as Error).message })
    }
  }
  return { checked: results.length, changed: results.filter((row) => 'changed' in row && row.changed).length, results }
})

app.get('/api/sources/events', async (request) => {
  const query = request.query as { all?: string } | undefined
  const events = listSourceEvents(query?.all === '1')
  return { events, unacknowledged: events.filter((row) => !row.acknowledged).length }
})

app.post('/api/sources/events/:id/ack', async (request, reply) => {
  const { id } = request.params as { id: string }
  const acknowledged = acknowledgeSourceEvent(Number(id))
  if (!acknowledged) {
    reply.code(404)
    return { error: 'not found' }
  }
  return { acknowledged }
})

app.delete('/api/sources/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const removed = deleteSource(Number(id))
  if (!removed) {
    reply.code(404)
    return { error: 'not found' }
  }
  return { removed }
})

app.post('/api/sources/:id/check', async (request, reply) => {
  // Check reads the public API and records what it saw. It never writes to the library:
  // noticing a new commit and pulling it are separate decisions.
  const { id } = request.params as { id: string }
  const source = listSources().find((row) => row.id === Number(id))
  if (!source) {
    reply.code(404)
    return { error: 'not found' }
  }
  try {
    return await checkSource(source)
  } catch (error) {
    reply.code(502)
    return { error: (error as Error).message, repo: source.repo }
  }
})

/* --------------------------------- authoring ------------------------------ */

// A draft never lives in an agent folder: it is written under the app's own data directory and
// reaches an agent only through save, which goes through the placement engine.
app.get('/api/drafts', async () => {
  ensureDrafts()
  return { drafts: listDrafts() }
})

app.post('/api/drafts', async (request, reply) => {
  const body = (request.body ?? {}) as { name?: string; intent?: string; text?: string }
  if (body.intent && !body.name) {
    // A draft made from an intent is named from it and generated straight away.
    const created = createDraft({ intent: body.intent, origin: 'generated' })
    const generated = await generateDraft(created.meta.id, {
      intent: body.intent,
      supplied: (request.body as { supplied?: string } | undefined)?.supplied
    })
    if ('error' in generated) {
      reply.code(502)
      return { error: generated.error, detail: generated.detail, draft: created }
    }
    return { draft: generated.draft, repairs: generated.repairs }
  }
  return { draft: createDraft(body) }
})

app.get('/api/drafts/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const draft = readDraft(id)
  if (!draft) {
    reply.code(404)
    return { error: 'not-found', detail: id }
  }
  return { draft }
})

app.put('/api/drafts/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { text?: string }
  if (typeof body.text !== 'string') {
    reply.code(400)
    return { error: 'text-required' }
  }
  const saved = writeDraft(id, body.text)
  if ('error' in saved) {
    reply.code(404)
    return saved
  }
  return saved
})

app.post('/api/drafts/:id/validate', async (request, reply) => {
  const { id } = request.params as { id: string }
  const draft = readDraft(id)
  if (!draft) {
    reply.code(404)
    return { error: 'not-found', detail: id }
  }
  const body = (request.body ?? {}) as { text?: string }
  return { validation: validateDraft(body.text ?? draft.text, { folder: draft.meta.name, dir: draftDirectory(id) ?? undefined }) }
})

app.post('/api/drafts/:id/generate', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { intent?: string; provider?: string; model?: string; supplied?: string }
  if (!body.intent?.trim()) {
    reply.code(400)
    return { error: 'intent-required' }
  }
  const result = await generateDraft(id, body as { intent: string })
  if ('error' in result) {
    reply.code(502)
    return result
  }
  return result
})

app.post('/api/drafts/:id/improve', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { provider?: string; model?: string; supplied?: string; instruction?: string }
  const result = await improveDraft(id, body)
  if ('error' in result) {
    reply.code(502)
    return result
  }
  // The proposal is read against the draft as it stands: the author sees the diff before it lands.
  const dir = draftDirectory(id)
  return {
    ...result,
    diff: dir ? diffPackages(dir, { files: new Map([['SKILL.md', result.text]]) }) : null
  }
})

app.post('/api/drafts/:id/save', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { rootPath?: string; name?: string; replace?: boolean }
  if (!body.rootPath) {
    reply.code(400)
    return { error: 'rootPath-required' }
  }
  const root = loadRegistry().roots.find((entry) => entry.path === body.rootPath)
  if (!root) {
    reply.code(400)
    return { error: 'unknown-root', detail: body.rootPath }
  }
  const result = saveDraft(id, { rootPath: root.path, name: body.name, replace: body.replace })
  if ('error' in result) {
    reply.code(result.error === 'exists' ? 409 : 400)
    return result
  }
  await fullScan()
  return { result }
})

app.post('/api/drafts/:id/undo', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { journalId?: number }
  if (!body.journalId) {
    reply.code(400)
    return { error: 'journalId-required' }
  }
  const row = getDb().prepare('SELECT payload FROM journal WHERE id = ?').get(body.journalId) as { payload: string } | undefined
  if (!row) {
    reply.code(404)
    return { error: 'journal-missing', detail: body.journalId }
  }
  const payload = JSON.parse(row.payload) as { target: string; rootPath: string; snapshot: string | null }
  const undone = undoDraftSave(body.journalId, payload.snapshot, payload.target, payload.rootPath)
  await fullScan()
  return { result: undone, draftId: id }
})

app.get('/api/drafts/:id/links', async (request, reply) => {
  const { id } = request.params as { id: string }
  const dir = draftDirectory(id)
  if (!dir) {
    reply.code(404)
    return { error: 'not-found', detail: id }
  }
  return { links: listLinks(dir), composite: listLinks(dir).length > 0 }
})

app.post('/api/drafts/:id/links', async (request, reply) => {
  const { id } = request.params as { id: string }
  const dir = draftDirectory(id)
  if (!dir) {
    reply.code(404)
    return { error: 'not-found', detail: id }
  }
  const body = (request.body ?? {}) as { repo?: string; sourcePath?: string; mode?: string; track?: string }
  if (!body.repo || !body.sourcePath) {
    reply.code(400)
    return { error: 'repo-and-path-required' }
  }
  const link = addLink({
    targetPath: dir,
    repo: body.repo,
    sourcePath: body.sourcePath,
    mode: (body.mode as 'distill' | 'attach' | 'summarize' | undefined) ?? 'distill',
    track: (body.track as 'commit' | 'release' | undefined) ?? 'commit'
  })
  if ('error' in link) {
    reply.code(link.error === 'duplicate-link' ? 409 : 400)
    return link
  }
  addJournal('draft-link', { id, linkId: link.id })
  return { link }
})

app.get('/api/workspaces', async () => ({ workspaces: listWorkspaces() }))

app.post('/api/workspaces', async (request, reply) => {
  const body = request.body as { path?: string; name?: string } | undefined
  const workspacePath = (body?.path ?? '').trim()
  if (!workspacePath || !existsSync(workspacePath)) {
    reply.code(400)
    return { error: 'path must exist' }
  }
  const name = (body?.name ?? '').trim() || path.basename(workspacePath)
  return { workspace: saveWorkspace(name, workspacePath) }
})

app.delete('/api/workspaces/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const removed = deleteWorkspace(Number(id))
  if (!removed) {
    reply.code(404)
    return { error: 'not found' }
  }
  return { removed }
})

app.post('/api/workspaces/:id/import', async (request, reply) => {
  // Bringing a skill into a workspace is a copy with provenance, so the workspace can be
  // compared again later and the file it came from is named in the manifest.
  const { id } = request.params as { id: string }
  const workspace = listWorkspaces().find((row) => row.id === Number(id))
  if (!workspace) {
    reply.code(404)
    return { error: 'not found' }
  }
  const body = request.body as { skillId?: number } | undefined
  const skill = body?.skillId ? getSkill(body.skillId) : undefined
  if (!skill) {
    reply.code(400)
    return { error: 'skillId is required' }
  }

  const skillsDir = path.join(workspace.path, 'skills')
  const target = path.join(skillsDir, path.basename(skill.path))
  if (existsSync(target)) {
    reply.code(409)
    return { error: 'already-in-workspace', target }
  }

  try {
    mkdirSync(skillsDir, { recursive: true })
    cpSync(skill.path, target, { recursive: true })
    writeFileSync(
      path.join(target, MANIFEST),
      JSON.stringify({ source: skill.path, importedAt: new Date().toISOString(), from: 'library' }, null, 2)
    )
    addJournal('workspace-import', { skillId: skill.id, workspace: workspace.name, target })
    return { ok: true, target }
  } catch (error) {
    reply.code(500)
    return { error: (error as Error).message }
  }
})

app.get('/api/workspaces/:id/compare', async (request, reply) => {
  // A workspace is a repository that keeps its own skills. Compare by name and by the hash of
  // SKILL.md, so "same skill, different content" cannot hide behind a matching name.
  const { id } = request.params as { id: string }
  const workspace = listWorkspaces().find((row) => row.id === Number(id))
  if (!workspace) {
    reply.code(404)
    return { error: 'not found' }
  }
  const skillDirs: string[] = []
  for (const candidate of ['skills', path.join('.claude', 'skills'), path.join('.agents', 'skills')]) {
    const full = path.join(workspace.path, candidate)
    if (!existsSync(full)) continue
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(full, entry.name, 'SKILL.md'))) {
        skillDirs.push(path.join(full, entry.name))
      }
    }
  }
  const hashOf = (dir: string): string => {
    try {
      return createHash('sha256').update(readFileSync(path.join(dir, 'SKILL.md'))).digest('hex')
    } catch {
      return ''
    }
  }

  const rows = skillDirs.map((dir) => {
    const name = path.basename(dir)
    const hash = hashOf(dir)
    const known = querySkills({ q: name, limit: 200 }).rows.find((row) => row.name === name)
    if (!known) return { name, state: 'workspace-only' as const, hash }
    const libraryHash = hashOf(known.path)
    return {
      name,
      state: hash === libraryHash ? ('same' as const) : ('different' as const),
      hash,
      libraryHash,
      skillId: known.id
    }
  })

  return {
    workspace: workspace.name,
    path: workspace.path,
    total: rows.length,
    same: rows.filter((row) => row.state === 'same').length,
    different: rows.filter((row) => row.state === 'different').length,
    workspaceOnly: rows.filter((row) => row.state === 'workspace-only').length,
    rows
  }
})

app.post('/api/presets', async (request, reply) => {
  const body = request.body as { name?: string; agents?: string[] } | undefined
  const name = (body?.name ?? '').trim()
  const agents = (body?.agents ?? []).filter((agent) => typeof agent === 'string' && agent)
  if (!name || !agents.length) {
    reply.code(400)
    return { error: 'name and at least one agent are required' }
  }
  return { preset: savePreset(name, agents) }
})

app.delete('/api/presets/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const removed = deletePreset(Number(id))
  if (!removed) {
    reply.code(404)
    return { error: 'not found' }
  }
  return { removed }
})

app.post('/api/presets/:id/apply', async (request, reply) => {
  // A preset is a promise about several agents at once, so it reports per agent and per skill
  // rather than collapsing to a total that hides which one refused.
  const { id } = request.params as { id: string }
  const preset = listPresets().find((row) => row.id === Number(id))
  if (!preset) {
    reply.code(404)
    return { error: 'not found' }
  }
  const body = request.body as { ids?: number[] } | undefined
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((value) => Number.isFinite(value)) : []
  if (!ids.length) {
    reply.code(400)
    return { error: 'ids is required' }
  }

  const registry = loadRegistry()
  const results: Array<{ agent: string; id: number; ok: boolean; error?: string; mode?: string }> = []
  for (const agent of preset.agents) {
    const root = registry.roots.find((entry) => entry.exists && entry.owners.includes(agent))
    if (!root) {
      for (const skillId of ids) results.push({ agent, id: skillId, ok: false, error: 'no-root' })
      continue
    }
    for (const skillId of ids) {
      const skill = getSkill(skillId)
      if (!skill) {
        results.push({ agent, id: skillId, ok: false, error: 'not-found' })
        continue
      }
      const target = path.join(root.path, path.basename(skill.path))
      try {
        if (skill.risk === 'high') {
          results.push({ agent, id: skillId, ok: false, error: 'blocked-by-scan' })
          continue
        }
        if (existsSync(target)) {
          results.push({ agent, id: skillId, ok: true, mode: 'already-on' })
          continue
        }
        const placed = place(skill.path, root.path)
        addJournal('place', { skillId, agent, target: placed.target, mode: placed.mode, preset: preset.name })
        results.push({ agent, id: skillId, ok: true, mode: placed.mode })
      } catch (error) {
        results.push({ agent, id: skillId, ok: false, error: (error as Error).message })
      }
    }
  }

  return {
    preset: preset.name,
    agents: preset.agents.length,
    placed: results.filter((row) => row.ok && row.mode !== 'already-on').length,
    alreadyOn: results.filter((row) => row.mode === 'already-on').length,
    failed: results.filter((row) => !row.ok).length,
    results
  }
})

app.post('/api/skills/:id/switch', async (request, reply) => {
  // Off means the platform stops seeing the skill, and the folder moves inside that platform's
  // own `.archive`. Nothing is deleted: `.archive/<name>` is the exact inverse of the switch.
  // The live location comes from the index, never from root + name: skills sit in category and
  // tag subfolders, so root + name points at a directory that does not exist.
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { agent?: string; on?: boolean }
  if (!body.agent || typeof body.on !== 'boolean') {
    reply.code(400)
    return { error: 'agent and on are required' }
  }
  const row = getDb()
    .prepare('SELECT id, name, path, root_path FROM skills WHERE id = ?')
    .get(Number(id)) as { id: number; name: string; path: string; root_path: string } | undefined
  if (!row) {
    reply.code(404)
    return { error: 'not found' }
  }
  const registry = loadRegistry()
  const root = registry.roots.find((entry) => entry.exists && entry.path === row.root_path)
  if (!root) {
    reply.code(404)
    return { error: `no detected root for ${body.agent}` }
  }
  const archiveRoot = path.join(root.path, '.archive')
  const isArchived = row.path.split(/[\\/]/).includes('.archive')
  const ORIGIN = '.skill-academy-origin.json'

  if (body.on === false) {
    const live = row.path
    const parked = path.join(archiveRoot, row.name)
    if (!existsSync(live)) {
      reply.code(409)
      return { error: 'not-in-root', path: live }
    }
    if (isArchived) {
      reply.code(409)
      return { error: 'already-archived', path: live }
    }
    mkdirSync(archiveRoot, { recursive: true })
    if (existsSync(parked)) {
      reply.code(409)
      return { error: 'archive-name-taken', path: parked }
    }
    const relative = path.relative(root.path, live).split('\\').join('/')
    // Move first, then leave a note behind: writing inside the package before the move keeps a
    // handle open long enough for Windows to refuse the rename with EPERM.
    let moved = false
    for (let attempt = 0; attempt < 4 && !moved; attempt += 1) {
      try {
        renameSync(live, parked)
        moved = true
      } catch (error) {
        if (attempt === 3) {
          reply.code(409)
          return { error: 'locked', detail: (error as Error).message, path: live }
        }
        await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
      }
    }
    try {
      writeFileSync(path.join(parked, ORIGIN), JSON.stringify({ root: root.path, relative }, null, 2))
    } catch {
      /* a read-only package still archives, it just restores flat */
    }
    addJournal('platform-archive', { agent: body.agent, from: live, to: parked, relative })
    return { on: false, agent: body.agent, movedTo: parked, from: live }
  }

  // After an archive the index still points at the old live path until the next scan, so the
  // parked folder is looked up by name as well.
  const candidate = path.join(archiveRoot, row.name)
  const parked = isArchived && existsSync(row.path) ? row.path : candidate
  if (!existsSync(parked)) {
    reply.code(409)
    return { error: 'not-archived', path: parked }
  }
  let relative = `${row.name}`
  try {
    const origin = JSON.parse(readFileSync(path.join(parked, ORIGIN), 'utf8')) as { relative?: string }
    if (origin.relative) relative = origin.relative
  } catch {
    /* no origin written: fall back to the root */
  }
  const live = path.join(root.path, relative)
  if (existsSync(live)) {
    reply.code(409)
    return { error: 'name-taken-in-root', path: live }
  }
  mkdirSync(path.dirname(live), { recursive: true })
  renameSync(parked, live)
  try {
    const manifest = path.join(live, ORIGIN)
    if (existsSync(manifest)) unlinkSync(manifest)
  } catch {
    /* leaving the manifest behind is harmless */
  }
  addJournal('platform-restore', { agent: body.agent, from: parked, to: live })
  return { on: true, agent: body.agent, movedTo: live }
})

app.post('/api/skills/bulk', async (request, reply) => {
  // Bulk work is the same action repeated, not a new action. Every id goes through the
  // single-row path so each one is journalled, and a failure on one never takes the rest down.
  const body = request.body as { action?: string; ids?: number[]; reason?: string } | undefined
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((id) => Number.isFinite(id)) : []
  if (!ids.length) {
    reply.code(400)
    return { error: 'ids is required' }
  }
  const action = body?.action ?? 'archive'
  const agent = (request.body as { agent?: string } | undefined)?.agent

  if (action !== 'archive' && action !== 'enable' && action !== 'disable') {
    reply.code(400)
    return { error: `unknown action: ${action}` }
  }
  if ((action === 'enable' || action === 'disable') && !agent) {
    reply.code(400)
    return { error: `${action} needs an agent` }
  }

  const registry = loadRegistry()
  const root = agent
    ? registry.roots.find((entry) => entry.exists && entry.owners.includes(agent))
    : undefined
  if ((action === 'enable' || action === 'disable') && !root) {
    reply.code(404)
    return { error: `no detected root for ${agent}` }
  }

  const results: Array<{ id: number; ok: boolean; error?: string; trashId?: number; mode?: string }> = []
  for (const id of ids) {
    const skill = getSkill(id)
    if (!skill) {
      results.push({ id, ok: false, error: 'not-found' })
      continue
    }
    try {
      if (action === 'archive') {
        const result = archiveSkill(id, body?.reason ?? 'bulk')
        results.push({ id, ok: true, trashId: result.trashId })
        continue
      }
      const target = path.join(root!.path, path.basename(skill.path))
      if (action === 'disable') {
        if (!existsSync(target)) {
          results.push({ id, ok: true, mode: 'already-off' })
          continue
        }
        unplace(target, TRASH_DIR)
        // unplace refuses what it did not create, and a directory someone else placed
        // must never be reported as switched off. Check the filesystem, not the return.
        if (existsSync(target)) {
          results.push({ id, ok: false, error: 'not-ours' })
          continue
        }
        addJournal('unplace', { skillId: id, agent, target, bulk: true })
        results.push({ id, ok: true, mode: 'off' })
        continue
      }
      if (skill.risk === 'high') {
        results.push({ id, ok: false, error: 'blocked-by-scan' })
        continue
      }
      if (existsSync(target)) {
        results.push({ id, ok: true, mode: 'already-on' })
        continue
      }
      const placed = place(skill.path, root!.path)
      addJournal('place', { skillId: id, agent, target: placed.target, mode: placed.mode, bulk: true })
      results.push({ id, ok: true, mode: placed.mode })
    } catch (error) {
      results.push({ id, ok: false, error: (error as Error).message })
    }
  }

  return {
    action,
    total: ids.length,
    archived: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
    results
  }
})

app.get('/api/skills/:id/compare', async (request, reply) => {
  // Compare with latest, without a model in the loop: what the two copies actually say.
  // The AI pass can summarise this later; the diff is the part that must never be guessed.
  const { id } = request.params as { id: string }
  const row = getSkill(Number(id))
  if (!row) {
    reply.code(404)
    return { error: 'not found' }
  }
  const self = provenanceOf(row.path, String(row.mtime))
  const copies = copiesOfName(row.name).filter((copy) => copy.id !== row.id)
  const newest = copies
    .map((copy) => ({ ...copy, ...provenanceOf(copy.path, copy.mtime) }))
    .filter((copy) => copy.version)
    .sort((a, b) => compareVersions(a.version, b.version))
    .at(-1)
  if (!newest || !self.version || compareVersions(self.version, newest.version) >= 0) {
    reply.code(409)
    return { error: 'nothing-newer', thisVersion: self.version ?? null }
  }

  const read = (dir: string): string => {
    try {
      return readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    } catch {
      return ''
    }
  }
  const mine = read(row.path).split(/\r?\n/)
  const theirs = read(newest.path).split(/\r?\n/)

  // Trim the common head and tail, then report the changed middle with line numbers.
  let head = 0
  while (head < mine.length && head < theirs.length && mine[head] === theirs[head]) head += 1
  let tail = 0
  while (
    tail < mine.length - head &&
    tail < theirs.length - head &&
    mine[mine.length - 1 - tail] === theirs[theirs.length - 1 - tail]
  ) {
    tail += 1
  }
  const mineMiddle = mine.slice(head, mine.length - tail)
  const theirsMiddle = theirs.slice(head, theirs.length - tail)

  return {
    name: row.name,
    thisVersion: self.version,
    latestVersion: newest.version,
    latestRoot: newest.root_path,
    latestId: newest.id,
    changedFrom: head + 1,
    thisLines: mineMiddle.map((text, index) => ({ line: head + index + 1, text })),
    latestLines: theirsMiddle.map((text, index) => ({ line: head + index + 1, text })),
    identical: mineMiddle.length === 0 && theirsMiddle.length === 0
  }
})

app.post('/api/placements/repair', async (request, reply) => {
  // A tracked copy drifted from its source. Repair rewrites the copy from the source and
  // journals both halves, so the old copy is in the trash and the action can be undone.
  const body = request.body as { skillId?: number; agent?: string } | undefined
  const skill = body?.skillId ? getSkill(body.skillId) : undefined
  if (!skill || !body?.agent) {
    reply.code(400)
    return { error: 'skillId and agent are required' }
  }
  const registry = loadRegistry()
  const root = registry.roots.find((entry) => entry.exists && entry.owners.includes(body.agent!))
  if (!root) {
    reply.code(404)
    return { error: `no detected root for ${body.agent}` }
  }
  const target = path.join(root.path, path.basename(skill.path))
  const before = copyDrift(skill.path, target)
  if (!before.drifted) {
    reply.code(409)
    return { error: 'copy-matches-source', sourceHash: before.sourceHash, targetHash: before.targetHash }
  }
  const removed = unplace(target, TRASH_DIR)
  addJournal('repair', { skillId: skill.id, agent: body.agent, target, removed })
  const placed = place(skill.path, root.path, { forceCopy: true })
  addJournal('place', { skillId: skill.id, agent: body.agent, target: placed.target, mode: placed.mode, repaired: true })
  const after = copyDrift(skill.path, placed.target)
  return { ok: placed.ok && !after.drifted, mode: placed.mode, target: placed.target, before, after }
})

app.post('/api/placements', async (request, reply) => {
  const body = request.body as
    | { skillId?: number; agent?: string; action?: 'on' | 'off'; override?: boolean; reason?: string }
    | undefined
  const skill = body?.skillId ? getSkill(body.skillId) : undefined
  if (!skill || !body?.agent || (body.action !== 'on' && body.action !== 'off')) {
    reply.code(400)
    return { error: 'skillId, agent and action (on|off) are required' }
  }

  const registry = loadRegistry()
  const root = registry.roots.find((entry) => entry.exists && entry.owners.includes(body.agent!))
  if (!root) {
    reply.code(404)
    return { error: `no detected root for ${body.agent}` }
  }

  const target = path.join(root.path, path.basename(skill.path))
  const native = path.resolve(skill.path).toLowerCase().startsWith(`${path.resolve(root.path).toLowerCase()}${path.sep}`)
  if (native) return { state: 'native', mode: 'native', target }

  if (body.action === 'on') {
    // A package that failed the content scan cannot be switched on silently: the person
    // sees the file and line, and the override is written to the journal if they insist.
    const findings = safeJson(skill.findings, [] as { file: string; line: number; code: string; severity: string; excerpt: string }[])
    if (skill.risk === 'high' && !body.override) {
      reply.code(409)
      return { error: 'blocked-by-scan', risk: skill.risk, findings }
    }
    if (body.override) {
      addJournal('override', {
        skill: skill.path,
        agent: body.agent,
        root: root.path,
        risk: skill.risk,
        findings,
        reason: body.reason ?? ''
      })
    }
    const result = place(skill.path, root.path)
    addJournal('place', { skill: skill.path, agent: body.agent, root: root.path, target, result })
    if (!result.ok) {
      reply.code(409)
      return { error: result.reason, target: result.target }
    }
    rescanRoot(root.path)
    return { state: 'on', mode: result.mode, target: result.target }
  }

  const result = unplace(target, TRASH_DIR)
  addJournal('unplace', { skill: skill.path, agent: body.agent, root: root.path, target, result })
  if (!result.ok) {
    reply.code(409)
    return { error: result.reason, target }
  }
  rescanRoot(root.path)
  return { state: 'off', mode: result.mode, target, trashed: result.trashed }
})

/**
 * Move: one skill, several agent roots. One root keeps the real package ("core"); the others get a
 * link, or a copy when the footer switch says move.
 */
app.post('/api/skills/:id/move', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { coreRoot?: string; roots?: string[]; mode?: 'link' | 'move' }
  const skill = getSkill(Number(id))
  if (!skill) {
    reply.code(404)
    return { error: 'not-found' }
  }
  const registry = loadRegistry()
  const known = new Map(registry.roots.filter((root) => root.exists).map((root) => [path.resolve(root.path).toLowerCase(), root]))
  const coreRoot = body.coreRoot ? path.resolve(body.coreRoot) : path.dirname(path.resolve(skill.path))
  if (!known.has(coreRoot.toLowerCase())) {
    reply.code(400)
    return { error: 'unknown-root', detail: body.coreRoot }
  }
  const wanted = (body.roots ?? []).map((entry) => path.resolve(entry)).filter((entry) => entry.toLowerCase() !== coreRoot.toLowerCase())
  for (const entry of wanted) {
    if (!known.has(entry.toLowerCase())) {
      reply.code(400)
      return { error: 'unknown-root', detail: entry }
    }
  }

  let source = path.resolve((skill as { real_path?: string }).real_path ?? skill.path)
  const results: Array<{ root: string; action: string; ok: boolean; mode?: string; target?: string; reason?: string }> = []

  // The core root owns the bytes: if the package lives elsewhere it moves, it is not copied.
  const currentRoot = path.dirname(source).toLowerCase()
  if (currentRoot !== coreRoot.toLowerCase()) {
    const destination = path.join(coreRoot, path.basename(source))
    try {
      fs.renameSync(source, destination)
    } catch {
      try {
        cpSync(source, destination, { recursive: true })
        fs.rmSync(source, { recursive: true, force: true })
      } catch (error) {
        reply.code(409)
        return { error: 'move-failed', detail: (error as Error).message, results }
      }
    }
    results.push({ root: coreRoot, action: 'moved-package', ok: true, target: destination })
    source = destination
  } else {
    results.push({ root: coreRoot, action: 'kept-package', ok: true, target: source })
  }

  for (const root of wanted) {
    const placed = place(source, root, { forceCopy: body.mode === 'move' })
    results.push({
      root,
      action: body.mode === 'move' ? 'copied' : 'linked',
      ok: placed.ok,
      mode: placed.mode,
      target: placed.target,
      reason: placed.reason
    })
    if (!placed.ok && placed.reason !== 'linked-elsewhere') continue
  }

  addJournal('move', { skillId: skill.id, skill: source, coreRoot, mode: body.mode ?? 'link', results })
  await fullScan()
  broadcast({ type: 'library', root: null, added: 0, changed: 1, removed: 0, at: new Date().toISOString() })
  return { moved: source, core: coreRoot, results, ok: results.every((entry) => entry.ok) }
})

/** Wipe the whole trash. Every entry goes to the operating system's Recycle Bin, never unlinked. */
app.post('/api/trash/wipe', async (request, reply) => {
  const body = (request.body ?? {}) as { confirm?: boolean; onlyExpired?: boolean }
  if (body.confirm !== true) {
    reply.code(428)
    return { error: 'confirm-required', detail: { note: 'wiping the trash is irreversible inside the app' } }
  }
  const entries = body.onlyExpired ? expiredTrash() : listTrash()
  const results: Array<{ id: number; name: string; ok: boolean; reason?: string }> = []
  for (const entry of entries) {
    const purged = purgeTrash(entry.id)
    results.push({ id: entry.id, name: entry.name, ok: purged.ok, reason: purged.reason })
  }
  addJournal('trash-wipe', { wiped: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length })
  return { wiped: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok), results }
})

app.post('/api/skills/:id/archive', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { reason?: string }
  const result = archiveSkill(Number(id), body.reason ?? 'manual')
  if (!result.ok) {
    reply.code(result.reason === 'not-found' ? 404 : 409)
    return { error: result.reason }
  }
  broadcast({ type: 'library', root: null, added: 0, changed: 0, removed: 1, at: new Date().toISOString() })
  return { state: 'archived', trashedTo: result.trashedTo, trashId: result.trashId, journalId: result.journalId }
})

app.get('/api/trash', async () => ({ entries: listTrash(), expired: expiredTrash(), settings: readSettings() }))

app.post('/api/trash/:id/restore', async (request, reply) => {
  const { id } = request.params as { id: string }
  const result = restoreTrash(Number(id))
  if (!result.ok) {
    reply.code(409)
    return { error: result.reason }
  }
  broadcast({ type: 'library', root: null, added: 1, changed: 0, removed: 0, at: new Date().toISOString() })
  return { state: 'restored', restoredTo: result.restoredTo, journalId: result.journalId }
})

app.post('/api/trash/:id/purge', async (request, reply) => {
  const { id } = request.params as { id: string }
  const result = purgeTrash(Number(id))
  if (!result.ok) {
    reply.code(409)
    return { error: result.reason }
  }
  return { state: 'purged' }
})

app.post('/api/journal/:id/undo', async (request, reply) => {
  const { id } = request.params as { id: string }
  const result = undoJournal(Number(id))
  if (!result.ok) {
    reply.code(409)
    return { error: result.reason }
  }
  return { state: 'undone', action: result.action }
})

/* ------------------------------ versioning monitor ------------------------------ */

interface CheckJob {
  id: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'done' | 'failed'
  scope: string
  checked: number
  total: number
  events: number
  requests: number
  error?: string
}

const checkJobs = new Map<string, CheckJob>()

app.post('/api/monitor/check', async (request, reply) => {
  const body = (request.body ?? {}) as { repo?: string; installationId?: number; all?: boolean }
  ensureMonitorTables()
  const rows = listInstallations()
  const total = body.installationId ? 1 : body.repo ? rows.filter((row) => row.repo === body.repo).length : rows.length
  if (!total) {
    reply.code(409)
    return { error: 'nothing-installed', detail: 'no installation is recorded yet; install a skill first' }
  }
  const job: CheckJob = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    scope: body.repo ?? (body.installationId ? 'installation ' + body.installationId : 'all'),
    checked: 0,
    total,
    events: 0,
    requests: 0
  }
  checkJobs.set(job.id, job)
  void (async () => {
    try {
      const summary = await runCheck(body)
      job.checked = summary.outcomes.length
      job.events = summary.events
      job.requests = summary.requests
      job.status = 'done'
    } catch (error) {
      job.status = 'failed'
      job.error = (error as Error).message
    } finally {
      job.finishedAt = new Date().toISOString()
    }
  })()
  reply.code(202)
  return { job }
})

app.get('/api/monitor/job/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const job = checkJobs.get(id)
  if (!job) {
    reply.code(404)
    return { error: 'job-not-found' }
  }
  return { job }
})

/* ---------------------------- linked sources ---------------------------- */

/** A skill id is the only handle the screen has, so the path is resolved here, once. */
function targetOf(id: number): { path: string; name: string } | null {
  const row = getSkill(id)
  if (!row) return null
  return { path: (row as { real_path?: string }).real_path ?? row.path, name: row.name }
}

app.get('/api/skills/:id/links', async (request, reply) => {
  const { id } = request.params as { id: string }
  const target = targetOf(Number(id))
  if (!target) {
    reply.code(404)
    return { error: 'not-found' }
  }
  return { ...linksOverview(target.path), target }
})

app.post('/api/skills/:id/links', async (request, reply) => {
  const { id } = request.params as { id: string }
  const target = targetOf(Number(id))
  if (!target) {
    reply.code(404)
    return { error: 'not-found' }
  }
  const body = (request.body ?? {}) as {
    repo?: string
    sourcePath?: string
    sourceName?: string
    track?: 'release' | 'commit'
    ref?: string | null
    mode?: 'distill' | 'attach' | 'summarize'
  }
  if (!body.repo || !body.sourcePath) {
    reply.code(400)
    return { error: 'repo-and-path-required' }
  }
  const created = addLink({
    targetPath: target.path,
    skillId: Number(id),
    repo: body.repo,
    sourcePath: body.sourcePath,
    sourceName: body.sourceName,
    track: body.track,
    ref: body.ref ?? null,
    mode: body.mode
  })
  if ('error' in created) {
    reply.code(created.error === 'duplicate-link' ? 409 : 400)
    return created
  }
  return { link: created, ...linksOverview(target.path) }
})

app.patch('/api/links/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { mode?: 'distill' | 'attach' | 'summarize'; track?: 'release' | 'commit'; ref?: string | null }
  const updated = updateLink(Number(id), body)
  if (!updated) {
    reply.code(404)
    return { error: 'not-found' }
  }
  return { link: updated, ...linksOverview(updated.target_path) }
})

app.delete('/api/links/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const link = linkById(Number(id))
  if (!link) {
    reply.code(404)
    return { error: 'not-found' }
  }
  removeLink(Number(id))
  return { removed: true, ...linksOverview(link.target_path) }
})

app.post('/api/links/:id/check', async (request, reply) => {
  const { id } = request.params as { id: string }
  const status = await checkLink(Number(id))
  if ('error' in status) {
    reply.code(status.error === 'not-found' ? 404 : 502)
    return status
  }
  return { status }
})

app.post('/api/links/:id/plan', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { provider?: string; model?: string; includeCode?: boolean; supplied?: unknown }
  const settings = readSettings()
  const proposal = await planIngest({
    linkId: Number(id),
    provider: body.provider ?? settings.mergeProvider,
    model: body.model ?? settings.mergeModel,
    includeCode: body.includeCode,
    supplied: body.supplied
  })
  if ('error' in proposal) {
    const code =
      proposal.error === 'not-found' || proposal.error === 'target-missing'
        ? 404
        : proposal.error === 'no-change' || proposal.error === 'nothing-new'
          ? 409
          : proposal.error === 'provider-failed' || proposal.error === 'bad-answer'
            ? 502
            : 400
    reply.code(code)
    return proposal
  }
  return { proposal }
})

app.post('/api/ingest/apply', async (request, reply) => {
  const body = (request.body ?? {}) as { runId?: number; confirm?: boolean }
  if (!body.runId) {
    reply.code(400)
    return { error: 'runId-required' }
  }
  if (body.confirm !== true) {
    // Reading the dry run is one step; writing is another, and the second one is explicit.
    reply.code(428)
    return { error: 'confirm-required', detail: { note: 'apply needs confirm: true after the dry run was read' } }
  }
  const result = applyIngest(body.runId)
  if ('error' in result) {
    reply.code(result.error === 'local-changed' ? 409 : 400)
    return result
  }
  return { result }
})

app.post('/api/ingest/undo', async (request, reply) => {
  const body = (request.body ?? {}) as { runId?: number }
  if (!body.runId) {
    reply.code(400)
    return { error: 'runId-required' }
  }
  const result = undoIngest(body.runId)
  if ('error' in result) {
    reply.code(result.error === 'not-applied' ? 409 : 400)
    return result
  }
  return { result }
})

app.get('/api/links/runs', async (request) => {
  const query = request.query as { target?: string }
  return { runs: listRuns(query.target) }
})

app.get('/api/ingest/runs/:runId', async (request, reply) => {
  const { runId } = request.params as { runId: string }
  const run = getRun(Number(runId))
  if (!run) {
    reply.code(404)
    return { error: 'not-found' }
  }
  return { run }
})

/* ------------------------- merge planning (P4.5) ------------------------- */

function pathOfSkillId(id: number | undefined): { path: string; name: string } | null {
  if (!id) return null
  const row = getSkill(Number(id))
  if (!row) return null
  return { path: (row as { real_path?: string }).real_path ?? row.path, name: row.name }
}

app.post('/api/promote/plan', async (request, reply) => {
  const body = (request.body ?? {}) as {
    winnerPath?: string
    loserPath?: string
    winnerId?: number
    loserId?: number
    contradictions?: boolean
    provider?: string
    model?: string
  }
  const settings = readSettings()
  const winnerPath = body.winnerPath ?? pathOfSkillId(body.winnerId)?.path
  const loserPath = body.loserPath ?? pathOfSkillId(body.loserId)?.path
  if (!winnerPath || !loserPath) {
    reply.code(400)
    return { error: 'winner-and-loser-required' }
  }
  const plan = await planPromote({
    winnerPath,
    loserPath,
    contradictions: body.contradictions === true,
    provider: body.provider ?? settings.mergeProvider,
    model: body.model ?? settings.mergeModel
  })
  if ('error' in plan) {
    reply.code(plan.error.includes('missing') ? 404 : 400)
    return plan
  }
  return { plan }
})

app.get('/api/promote/plan/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const plan = promotePlanById(id)
  if (!plan) {
    reply.code(404)
    return { error: 'not-found' }
  }
  return { plan }
})

app.post('/api/promote/apply', async (request, reply) => {
  const body = (request.body ?? {}) as { planId?: string; drop?: string[]; add?: string[]; ack?: boolean }
  if (!body.planId) {
    reply.code(400)
    return { error: 'planId-required' }
  }
  const result = applyPromote({ planId: body.planId, drop: body.drop, add: body.add, ack: body.ack === true })
  if ('error' in result) {
    reply.code(result.error === 'plan-stale' ? 409 : result.error === 'ack-required' ? 428 : 400)
    return result
  }
  return { result }
})

app.post('/api/merge-into-x/plan', async (request, reply) => {
  const body = (request.body ?? {}) as {
    groupKey?: string
    name?: string
    targetPath?: string
    suppliedBody?: string
    provider?: string
    model?: string
  }
  if (!body.groupKey || (!body.name && !body.targetPath)) {
    reply.code(400)
    return { error: 'group-and-name-required' }
  }
  const settings = readSettings()
  // A target is a skill that already exists: it absorbs the group instead of a new package appearing.
  if (body.targetPath) {
    const existing = await planFoldIntoExisting({
      groupKey: body.groupKey,
      targetPath: body.targetPath,
      suppliedBody: body.suppliedBody,
      provider: body.provider ?? settings.mergeProvider,
      model: body.model ?? settings.mergeModel
    })
    if ('error' in existing) {
      reply.code(existing.error === 'group-not-found' ? 404 : 400)
      return existing
    }
    return { plan: existing }
  }
  const plan = await planMergeIntoX({
    groupKey: body.groupKey,
    name: body.name as string,
    suppliedBody: body.suppliedBody,
    provider: body.provider ?? settings.mergeProvider,
    model: body.model ?? settings.mergeModel
  })
  if ('error' in plan) {
    reply.code(plan.error === 'group-not-found' ? 404 : 400)
    return plan
  }
  return { plan }
})

app.post('/api/merge-into-x/apply', async (request, reply) => {
  const body = (request.body ?? {}) as { planId?: string; ack?: boolean; failAfter?: number }
  if (!body.planId) {
    reply.code(400)
    return { error: 'planId-required' }
  }
  const planned = mergeIntoXPlan(body.planId)
  // `failAfter` is the rollback seam the harness uses; the app never sends it, and an existing
  // target has no staging to fail in.
  const result = planned?.existing
    ? applyFoldIntoExisting(body.planId, body.ack === true)
    : applyMergeIntoX(body.planId, body.ack === true, body.failAfter)
  if ('error' in result) {
    reply.code(result.error === 'plan-stale' ? 409 : result.error === 'plan-blocked' ? 428 : 400)
    return result
  }
  return { result }
})

app.post('/api/merge-into-x/undo', async (request, reply) => {
  const body = (request.body ?? {}) as { journalId?: number }
  if (!body.journalId) {
    reply.code(400)
    return { error: 'journalId-required' }
  }
  const result = undoFoldIntoExisting(Number(body.journalId))
  if ('error' in result) {
    reply.code(400)
    return result
  }
  return { result }
})

app.post('/api/improve/job', async (request, reply) => {
  const body = (request.body ?? {}) as { skillId?: number; path?: string; instruction?: string; provider?: string; model?: string }
  const target = body.path ?? pathOfSkillId(body.skillId)?.path
  if (!target) {
    reply.code(400)
    return { error: 'skill-required' }
  }
  if (!body.instruction || body.instruction.trim().length < 8) {
    reply.code(400)
    return { error: 'instruction-required' }
  }
  const settings = readSettings()
  const job = await startImprove({
    skillPath: target,
    instruction: body.instruction.trim(),
    provider: body.provider ?? settings.mergeProvider,
    model: body.model ?? settings.mergeModel
  })
  if ('error' in job) {
    reply.code(job.error === 'not-a-skill' ? 404 : 400)
    return job
  }
  return { job }
})

app.get('/api/improve/job/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const job = getImproveJob(Number(id))
  if (!job) {
    reply.code(404)
    return { error: 'not-found' }
  }
  return { job }
})

app.get('/api/improve/jobs', async (request) => {
  const query = request.query as { skillId?: string; path?: string }
  const target = query.path ?? pathOfSkillId(query.skillId ? Number(query.skillId) : undefined)?.path
  return { jobs: listImproveJobs(target) }
})

app.post('/api/improve/apply', async (request, reply) => {
  const body = (request.body ?? {}) as { jobId?: number; files?: string[]; confirm?: boolean }
  if (!body.jobId) {
    reply.code(400)
    return { error: 'jobId-required' }
  }
  if (body.confirm !== true) {
    reply.code(428)
    return { error: 'confirm-required', detail: { note: 'apply needs confirm: true after the diff was read' } }
  }
  const result = applyImprove(Number(body.jobId), body.files)
  if ('error' in result) {
    reply.code(result.error === 'plan-stale' ? 409 : 400)
    return result
  }
  return { result }
})

app.post('/api/improve/undo', async (request, reply) => {
  const body = (request.body ?? {}) as { jobId?: number }
  if (!body.jobId) {
    reply.code(400)
    return { error: 'jobId-required' }
  }
  const result = undoImprove(Number(body.jobId))
  if ('error' in result) {
    reply.code(result.error === 'not-applied' ? 409 : 400)
    return result
  }
  return { result }
})

app.get('/api/monitor', async () => monitorOverview())

app.get('/api/monitor/installation/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const installation = installationById(Number(id))
  if (!installation) {
    reply.code(404)
    return { error: 'installation-not-found' }
  }
  return {
    installation,
    drift: localDrift(installation),
    events: listEvents(true).filter((event) => event.installation_id === installation.id)
  }
})

app.post('/api/monitor/installation/:id/check', async (request, reply) => {
  const { id } = request.params as { id: string }
  const installation = installationById(Number(id))
  if (!installation) {
    reply.code(404)
    return { error: 'installation-not-found' }
  }
  const outcome = await checkInstallation(installation, { allowCache: false })
  return { outcome }
})

/** Tree, package to package and file to file, all three from the one comparison. */
app.get('/api/monitor/installation/:id/diff', async (request, reply) => {
  const { id } = request.params as { id: string }
  const query = request.query as { level?: string; path?: string; source?: string }
  const installation = installationById(Number(id))
  if (!installation) {
    reply.code(404)
    return { error: 'installation-not-found' }
  }
  const meta = await repoMeta(installation.repo)
  if (meta.unreachable) {
    reply.code(409)
    return { error: 'unreachable', detail: meta.error }
  }
  const release = await latestRelease(installation.repo)
  const target = installation.pin_ref
    ? installation.pin_ref
    : installation.policy_channel === 'head'
      ? meta.defaultBranch
      : release.tag ?? meta.defaultBranch
  const tree = await fetchTree(installation.repo, target, false)
  if (tree.error) {
    reply.code(409)
    return { error: 'tree-unavailable', detail: tree.error }
  }
  const remote = subtree(tree.files, installation.remote_path)
  const diff = packageDiff(installation, remote)
  if ((query.level ?? 'package') === 'tree') {
    // The list has to carry the user's own edits as well: upstream changing nothing and the local
    // copy having been rewritten are both reasons a file needs reading.
    const drift = localDrift(installation)
    // A file upstream left alone but the user edited is the one case that matters most, so it is
    // listed even though it is not an upstream change.
    const upstreamChanged = new Set(
      diff.files.filter((file) => file.status !== 'same').map((file) => file.path)
    )
    const localRows = [
      ...drift.localChanged
        .filter((entry) => !upstreamChanged.has(entry))
        .map((entry) => ({ path: entry, status: 'local-changed' })),
      ...drift.localAdded.map((entry) => ({ path: entry, status: 'local-added' })),
      ...drift.localRemoved.map((entry) => ({ path: entry, status: 'local-removed' }))
    ]
    return { level: 'tree', target, treeSha: tree.treeSha, truncated: tree.truncated, files: diff.files, local: localRows }
  }
  const requested = query.path ?? ''
  let wanted = diff.files.find((file) => file.path === requested)
  if (!wanted) {
    // A path the user edited, which upstream did not touch, still deserves a line diff.
    const remoteEntry = remote.find((file) => file.path === requested)
    const drift = localDrift(installation)
    const knowsIt =
      drift.localChanged.includes(requested) || drift.localAdded.includes(requested) || drift.localRemoved.includes(requested)
    if (!knowsIt) {
      reply.code(404)
      return { error: 'file-not-in-comparison', detail: query.path }
    }
    wanted = {
      path: requested,
      remotePath: remoteEntry?.path ?? null,
      status: remoteEntry ? 'changed' : drift.localAdded.includes(requested) ? 'added' : 'removed',
      installedBlob: null,
      remoteBlob: remoteEntry?.blob ?? null,
      installedBytes: null,
      remoteBytes: remoteEntry?.bytes ?? null
    }
  }
  const detail = await fileDiff(installation, wanted, query.source === 'local' ? 'local' : 'remote')
  return { level: 'file', target, diff: detail }
})

app.post('/api/monitor/installation/:id/plan', async (request, reply) => {
  const { id } = request.params as { id: string }
  const plan = await planUpdate(Number(id))
  if ('error' in plan) {
    reply.code(plan.error === 'installation-not-found' ? 404 : 409)
    return plan
  }
  return { plan }
})

app.post('/api/monitor/installation/:id/update', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { planId?: string; choice?: 'refuse' | 'take-upstream'; confirm?: boolean }
  if (!body.confirm) {
    reply.code(428)
    return { error: 'confirmation-required', detail: 'send confirm: true after reading the plan' }
  }
  const result = await applyUpdate({ installationId: Number(id), planId: body.planId, choice: body.choice })
  if ('error' in result) {
    reply.code(result.error === 'installation-not-found' ? 404 : 409)
    return result
  }
  return { result }
})

app.post('/api/monitor/installation/:id/rollback', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { trashPath?: string }
  if (!body.trashPath) {
    reply.code(400)
    return { error: 'trashPath is required' }
  }
  const result = rollbackInstallation(Number(id), body.trashPath)
  if (!result.restored) {
    reply.code(409)
    return { error: result.error }
  }
  return result
})

app.post('/api/monitor/installation/:id/pin', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { ref?: string | null; note?: string }
  const ok = setPin(Number(id), body.ref ?? null, body.note)
  if (!ok) {
    reply.code(404)
    return { error: 'installation-not-found' }
  }
  return { installation: installationById(Number(id)) }
})

app.post('/api/monitor/installation/:id/policy', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { channel?: Channel; auto?: AutoPolicy }
  if (!body.channel || !body.auto) {
    reply.code(400)
    return { error: 'channel and auto are required' }
  }
  const ok = setPolicy(Number(id), body.channel, body.auto)
  if (!ok) {
    reply.code(404)
    return { error: 'installation-not-found' }
  }
  return { installation: installationById(Number(id)) }
})

app.get('/api/monitor/events', async (request) => {
  const query = request.query as { all?: string }
  return { events: listEvents(query.all === '1') }
})

app.post('/api/monitor/events/ack', async (request) => {
  const body = (request.body ?? {}) as { ids?: number[] }
  return { acknowledged: acknowledgeEvents(body.ids ?? []) }
})

app.get('/api/monitor/unrecorded', async () => ({ rows: unrecordedSkills() }))

app.post('/api/monitor/adopt', async (request, reply) => {
  const body = (request.body ?? {}) as { path?: string; repo?: string; remotePath?: string; ref?: string }
  if (!body.path) {
    reply.code(400)
    return { error: 'path is required' }
  }
  const result = adoptLibrarySkill({ path: body.path, repo: body.repo, remotePath: body.remotePath, ref: body.ref })
  if ('error' in result) {
    reply.code(result.error === 'not-a-skill' ? 404 : 409)
    return result
  }
  return result
})

app.get('/api/monitor/export', async (_request, reply) => {
  reply.header('content-type', 'application/x-ndjson')
  reply.header('content-disposition', 'attachment; filename="skill-academy.monitor.ndjson"')
  return exportMonitor()
})

app.get('/api/settings', async () => ({ settings: readSettings() }))

app.post('/api/settings', async (request) => {
  const body = (request.body ?? {}) as {
    archiveDir?: string
    trashDays?: number
    mergeProvider?: string
    mergeModel?: string
  }
  return { settings: writeSettings(body) }
})

app.get('/api/journal', async (request) => {
  const { limit } = request.query as { limit?: string }
  return { entries: recentJournal(limit ? Number(limit) : 50) }
})

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

// One port for the product: the built interface is served by the same process that
// answers the API, so there is no dev proxy to point at the wrong port.
const UI_DIR = path.join(REPO_ROOT, 'web', 'dist')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
}

app.setNotFoundHandler((request, reply) => {
  const url = (request.raw.url ?? '/').split('?')[0]
  if (url.startsWith('/api/')) {
    reply.code(404)
    return { error: 'not found' }
  }
  const relative = decodeURIComponent(url).replace(/^\/+/, '')
  const candidate = path.join(UI_DIR, relative)
  const inside = path.relative(UI_DIR, candidate)
  const safe = inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside)
  const chosen = safe && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(UI_DIR, 'index.html')
  if (!fs.existsSync(chosen)) {
    reply.code(503)
    return { error: 'interface not built: npm run build' }
  }
  reply.type(MIME[path.extname(chosen)] ?? 'application/octet-stream')
  return fs.readFileSync(chosen)
})

startPoller()

app
  .listen({ port: API_PORT, host: HOST })
  .then(async () => {
    console.log(`api listening on http://${HOST}:${API_PORT}`)
    const result = await fullScan()
    console.log(
      `initial scan ${result.ms}ms, ${result.skills} skills, ` +
        (WATCH_ENABLED ? `watching ${watcher.size} roots` : 'watcher off (SKILL_ACADEMY_WATCH=1 to enable)')
    )
    setInterval(() => {
      void (async () => {
        const sweep = await fullScan()
        if (sweep.added + sweep.changed + sweep.removed > 0) {
          broadcast({ type: 'library', root: null, ...sweep, at: lastScanAt })
        }
      })().catch(() => undefined)
    }, 5 * 60_000).unref()
  })
  .catch((error) => {
    console.error('api failed to start:', error)
    process.exit(1)
  })

async function shutdown(): Promise<void> {
  await watcher.close()
  await app.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
