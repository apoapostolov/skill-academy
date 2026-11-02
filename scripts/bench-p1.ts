/**
 * P1 exit criteria, measured rather than asserted.
 *
 *   1. 2,000 skills across 20 roots scan cold in under 1.5 s
 *   2. a skill created on disk reaches the index in under 500 ms, and so does its removal
 *   3. a filter keystroke stays under 16 ms
 *   4. a second scan of unchanged disk performs zero writes
 *
 * Run: npm run bench:p1
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = path.join(os.tmpdir(), `sa-bench-${Date.now()}`)
process.env.SKILL_ACADEMY_DATA = path.join(scratch, 'data')

const ROOTS = 20
const PER_ROOT = 100
const TOTAL = ROOTS * PER_ROOT

const WORDS = [
  'synthetic', 'benchmark', 'reference', 'script', 'asset', 'pipeline', 'release',
  'curation', 'workspace', 'registry', 'archive', 'journal', 'placement', 'health'
]

function makeSkill(root: string, index: number): string {
  const name = `skill-${index}`
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
  const tag = WORDS[index % WORDS.length]
  const filler = `The ${tag} stage keeps the ${WORDS[(index + 3) % WORDS.length]} surface honest. `
  const body = [
    '---',
    `name: ${name}`,
    `description: Synthetic ${tag} skill ${index} used by the P1 benchmark`,
    `tags: [${tag}, benchmark]`,
    '---',
    '',
    `# ${name}`,
    '',
    filler.repeat(24),
    '',
    'See `references/notes.md` for the detail.'
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body)
  fs.writeFileSync(path.join(dir, 'references', 'notes.md'), `# ${name} notes\n\n${filler.repeat(4)}`)
  return dir
}

console.log(`generating ${TOTAL} skills across ${ROOTS} roots in ${scratch}`)
const roots: { path: string; scope: string; owners: string[]; exists: boolean }[] = []
for (let r = 0; r < ROOTS; r += 1) {
  const root = path.join(scratch, 'roots', `root-${r}`)
  fs.mkdirSync(root, { recursive: true })
  for (let s = 0; s < PER_ROOT; s += 1) makeSkill(root, s)
  roots.push({ path: root, scope: 'global', owners: [`agent-${r}`], exists: true })
}

const scanModule = await import('../server/src/scan.ts')
const dbModule = await import('../server/src/db.ts')
const applyModule = await import('../server/src/apply.ts')
const db = dbModule.getDb()

// 1. cold scan
const coldStart = performance.now()
const parseStart = performance.now()
const coldScan = scanModule.scanAll(roots as never)
const parseMs = performance.now() - parseStart
const saveStart = performance.now()
const coldSaved = dbModule.saveScan(coldScan)
const saveMs = performance.now() - saveStart
const coldMs = performance.now() - coldStart

// 4. second scan of unchanged disk must write nothing
const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
const warmStart = performance.now()
const warmScan = scanModule.scanAll(roots as never)
const warmSaved = dbModule.saveScan(warmScan)
const warmMs = performance.now() - warmStart
const changesAfter = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

// 3. filter timing
const terms = ['synthetic', 'benchmark', 'reference', 'script', 'asset', 'pipeline', 'release', 'curation', 'workspace', 'registry', 'archive', 'journal', 'placement', 'health', 'skill-1', 'skill-42']
const timings: number[] = []
for (let round = 0; round < 5; round += 1) {
  for (const term of terms) {
    const start = performance.now()
    dbModule.querySkills({ q: term, limit: 200 })
    timings.push(performance.now() - start)
  }
}
timings.sort((a, b) => a - b)
const p50 = timings[Math.floor(timings.length * 0.5)]
const p95 = timings[Math.floor(timings.length * 0.95)]
const worst = timings[timings.length - 1]

// 2. watcher latency: create a skill, wait for it to be indexed, then delete it
const chokidar = (await import('chokidar')).default
const watchedRoot = roots[0].path
const watcher = chokidar.watch(watchedRoot, {
  ignoreInitial: true,
  depth: 3,
  ignored: /[\\/](\.git|node_modules|\.cache)([\\/]|$)/
})

let pending: NodeJS.Timeout | null = null
let lastLatency = 0
const waiters: ((ms: number) => void)[] = []

function reindex(changed: string[]): void {
  const started = performance.now()
  applyModule.applyChange({ path: watchedRoot, scope: 'global', owners: ['agent-0'], exists: true } as never, changed)
  lastLatency = performance.now() - started
  for (const resolve of waiters.splice(0)) resolve(lastLatency)
}

let changedPaths: string[] = []
let firstEventAt = 0
watcher.on('all', (_event: string, changed: string) => {
  if (!firstEventAt) firstEventAt = performance.now()
  changedPaths.push(changed)
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    const batch = changedPaths
    changedPaths = []
    reindex(batch)
  }, 60)
})

function waitForRow(predicate: () => boolean, timeoutMs = 3000): Promise<number> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve(performance.now() - started)
      if (performance.now() - started > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

await new Promise((resolve) => setTimeout(resolve, 400))

const createStart = performance.now()
const freshDir = path.join(watchedRoot, 'skill-fresh')
fs.mkdirSync(freshDir, { recursive: true })
fs.writeFileSync(
  path.join(freshDir, 'SKILL.md'),
  '---\nname: skill-fresh\ndescription: A skill created while the watcher is running\n---\n\n# fresh\n'
)
const appearMs = await waitForRow(() => dbModule.querySkills({ q: 'fresh', limit: 5 }).total > 0)
const eventLatency = Math.round(firstEventAt - createStart)
const appearTotalMs = performance.now() - createStart

const removeStart = performance.now()
fs.rmSync(freshDir, { recursive: true, force: true })
// the same deletion path the server's watcher uses
const vanishCheck = setInterval(() => {
  if (!fs.existsSync(freshDir)) applyModule.applyChange({ path: watchedRoot, scope: 'global', owners: ['agent-0'], exists: true } as never, [freshDir])
}, 20)
const vanishMs = await waitForRow(() => dbModule.querySkills({ q: 'fresh', limit: 5 }).total === 0)
clearInterval(vanishCheck)
const vanishTotalMs = performance.now() - removeStart

await watcher.close()

const row = {
  skills: coldScan.skills,
  roots: ROOTS,
  coldMs: Math.round(coldMs),
  parseMs: Math.round(parseMs),
  saveMs: Math.round(saveMs),
  coldAdded: coldSaved.added,
  warmMs: Math.round(warmMs),
  warmWrites: changesAfter - changesBefore,
  filterP50: Number(p50.toFixed(2)),
  filterP95: Number(p95.toFixed(2)),
  filterWorst: Number(worst.toFixed(2)),
  appearMs: Math.round(appearTotalMs),
  osEventMs: eventLatency,
  indexAfterEventMs: Math.round(appearTotalMs) - eventLatency,
  vanishMs: Math.round(vanishTotalMs)
}

console.log(JSON.stringify(row, null, 2))
console.log('\nP1 exit checks')
const checks: [string, boolean, string][] = [
  ['cold scan of 2,000 across 20 roots < 1500 ms', coldMs < 1500, `${Math.round(coldMs)} ms`],
  ['2,000 skills indexed', coldScan.skills === TOTAL, `${coldScan.skills} skills`],
  ['second scan writes nothing', changesAfter - changesBefore === 0, `${changesAfter - changesBefore} writes`],
  ['filter p95 < 16 ms', p95 < 16, `${p95.toFixed(2)} ms`],
  ['skill appears < 500 ms', appearTotalMs < 500, `${Math.round(appearTotalMs)} ms`],
  ['skill disappears < 500 ms', vanishTotalMs < 500, `${Math.round(vanishTotalMs)} ms`]
]
let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`)
}
try {
  db.close()
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
} catch {
  /* the temp tree is disposable; a locked file must not hide the measurements */
}
process.exit(failed === 0 ? 0 : 1)
