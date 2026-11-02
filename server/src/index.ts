import fs from 'node:fs'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import Fastify from 'fastify'
import { API_PORT, APP_VERSION, DATA_DIR, DB_PATH, HOST, REPO_ROOT, WATCH_ENABLED } from './config'
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
  totals
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
import { copyDrift, place, unplace } from './placement'
import { applyChange } from './apply'
import { readPackage, readPackageFile, readPackageImageData } from './package'
import { compareVersions, provenanceOf } from './provenance'
import { loadRegistry } from './registry'
import { scanAll, scanOne } from './scan'
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

function fullScan(): { added: number; changed: number; removed: number; ms: number; skills: number } {
  const registry = loadRegistry()
  if (WATCH_ENABLED) watcher.sync(registry.roots)
  const outcome = scanAll(registry.roots)
  const result = saveScan(outcome)
  lastScanAt = new Date().toISOString()
  return { ...result, ms: outcome.ms, skills: outcome.skills }
}

const app = Fastify({ logger: false })

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
  const result = fullScan()
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

app.get('/api/settings', async () => ({ settings: readSettings() }))

app.post('/api/settings', async (request) => {
  const body = (request.body ?? {}) as { archiveDir?: string; trashDays?: number }
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

app
  .listen({ port: API_PORT, host: HOST })
  .then(() => {
    console.log(`api listening on http://${HOST}:${API_PORT}`)
    const result = fullScan()
    console.log(
      `initial scan ${result.ms}ms, ${result.skills} skills, ` +
        (WATCH_ENABLED ? `watching ${watcher.size} roots` : 'watcher off (SKILL_ACADEMY_WATCH=1 to enable)')
    )
    setInterval(() => {
      const sweep = fullScan()
      if (sweep.added + sweep.changed + sweep.removed > 0) {
        broadcast({ type: 'library', root: null, ...sweep, at: lastScanAt })
      }
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
