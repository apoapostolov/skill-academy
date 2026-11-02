import Fastify from 'fastify'
import { API_PORT, APP_VERSION, DATA_DIR, DB_PATH, HOST } from './config'
import { getSkill, querySkills, readMeta, readRoots, saveScan, tagFacets, totals } from './db'
import { loadRegistry } from './registry'
import { scanAll } from './scan'
import { readSkillBody } from './skill'

const startedAt = new Date()

interface RequestLine {
  at: string
  method: string
  url: string
  status: number
  ms: number
}

const requests: RequestLine[] = []

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
  const detected = registry.roots.filter((root) => root.exists)
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
      detected: detected.length
    },
    library: totals(),
    lastScanAt: readMeta('last_scan_at'),
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
  const registry = loadRegistry()
  const outcome = scanAll(registry.roots)
  const finishedAt = saveScan(outcome.roots, outcome.skills)
  const issues = outcome.skills.filter((skill) => skill.health.length > 0).length
  return {
    finishedAt,
    ms: outcome.ms,
    rootsScanned: outcome.roots.length,
    rootsDetected: registry.roots.filter((root) => root.exists).length,
    skills: outcome.skills.length,
    tokens: outcome.skills.reduce((sum, skill) => sum + skill.tokens, 0),
    issues,
    slowest: [...outcome.roots]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map((root) => ({ path: root.path, ms: root.ms }))
  }
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
      health: safeJson(row.health, [])
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
    body: readSkillBody(row.path)
  }
})

app.get('/api/facets', async () => {
  const roots = readRoots()
  const stored = new Map(roots.map((row) => [row.path, row]))
  const registry = loadRegistry()

  return {
    agents: registry.roots
      .filter((root) => root.exists)
      .map((root) => ({
        path: root.path,
        owners: root.owners,
        origin: root.origin,
        count: stored.get(root.path)?.skill_count ?? 0
      })),
    tags: tagFacets(),
    issues: totals().issues
  }
})

app.get('/api/dev/requests', async () => ({ requests }))

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
    console.log(`data ${DATA_DIR}`)
  })
  .catch((error) => {
    console.error('api failed to start:', error)
    process.exit(1)
  })
