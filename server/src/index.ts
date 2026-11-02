import Fastify from 'fastify'
import { API_PORT, APP_VERSION, DATA_DIR, DB_PATH, HOST } from './config'
import { readMeta, readRoots, saveScan } from './db'
import { loadRegistry } from './registry'
import { scanRoot, scanRoots } from './scan'

const startedAt = new Date()

interface RequestLine {
  at: string
  method: string
  url: string
  status: number
  ms: number
}

const requests: RequestLine[] = []

const app = Fastify({ logger: false, disableRequestLogging: true })

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
  const detected = registry.roots.filter((r) => r.exists)
  const stored = readRoots()
  const storedTotal = stored.reduce((sum, row) => sum + row.skill_count, 0)

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
    scan: {
      lastScanAt: readMeta('last_scan_at'),
      rootsScanned: stored.length,
      skills: storedTotal
    },
    requests: requests.length
  }
})

/**
 * Detection only: a stat per root. Counts come from the last scan, so this stays fast
 * enough to poll while the UI is open.
 */
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
        truncated: row ? Boolean(row.truncated) : false,
        lastScanAt: row?.last_scan_at ?? null
      }
    })
  }
})

/** The one write path in P0, and it writes to the index database only. */
app.post('/api/scan', async () => {
  const started = Date.now()
  const registry = loadRegistry()
  const results = scanRoots(registry.roots)
  const finishedAt = saveScan(results)

  return {
    finishedAt,
    ms: Date.now() - started,
    rootsScanned: results.length,
    rootsDetected: registry.roots.filter((r) => r.exists).length,
    skills: results.reduce((sum, row) => sum + row.count, 0),
    empty: results.filter((row) => row.count === 0).map((row) => row.path),
    slowest: [...results].sort((a, b) => b.ms - a.ms).slice(0, 5).map((row) => ({ path: row.path, ms: row.ms }))
  }
})

app.get('/api/roots/:path/scan', async (request) => {
  const { path } = request.params as { path: string }
  const registry = loadRegistry()
  const root = registry.roots.find((r) => r.path === path)
  if (!root) return { error: 'unknown root', path }
  return scanRoot(root)
})

app.get('/api/dev/requests', async () => ({ requests }))

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
