import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import Fastify from 'fastify'
import { API_PORT, APP_VERSION, DATA_DIR, DB_PATH, HOST } from './config'
import {
  addJournal,
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
import { place, unplace } from './placement'
import { applyChange } from './apply'
import { readPackage, readPackageFile } from './package'
import { provenanceOf } from './provenance'
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
  watcher.sync(registry.roots)
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

app.post('/api/scan', async () => {
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
  return {
    ...row,
    tags: safeJson(row.tags, []),
    health: safeJson(row.health, []),
    body: readSkillBody(row.path),
    package: readPackage(row.path)
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
          mode: hit?.mode ?? null
        }
      })
    )

  return { skill: { id: skill.id, name: skill.name, path: skill.path }, placements: rows }
})

app.post('/api/placements', async (request, reply) => {
  const body = request.body as { skillId?: number; agent?: string; action?: 'on' | 'off' } | undefined
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

app
  .listen({ port: API_PORT, host: HOST })
  .then(() => {
    console.log(`api listening on http://${HOST}:${API_PORT}`)
    const result = fullScan()
    console.log(`initial scan ${result.ms}ms, ${result.skills} skills, watching ${watcher.size} roots`)
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
