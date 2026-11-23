#!/usr/bin/env node
/**
 * The MCP server: the library an agent can ask about.
 *
 * Ten tools. Six act on the library (`list`, `search`, `enable`, `disable`, `scan`, `lock`) and four
 * read what the app's own screens read (`skill`, `improve`, `consolidate`, `curate`). It is a thin
 * client over the local service, which stays the source of truth, so an enable from here writes the
 * same journal entry the UI writes, and an audit from here is the same audit the app shows.
 *
 * Transport is stdio with newline-delimited JSON-RPC 2.0, which is what MCP clients speak.
 */
import {
  DEFAULT_BASE,
  ServiceError,
  apiPost,
  checkLock,
  consolidateGroups,
  curationReport,
  improveFindings,
  listSkills,
  resolveSkill,
  setEnabled,
  skillDetail
} from '../cli/api'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'skill-academy', version: '1.0.0' }

const BASE = (() => {
  const flag = process.argv.findIndex((arg) => arg === '--base')
  return flag >= 0 ? (process.argv[flag + 1] ?? DEFAULT_BASE) : DEFAULT_BASE
})()

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

const text = (value: unknown) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

const TOOLS: ToolDefinition[] = [
  {
    name: 'list',
    description: 'List skills in the library, newest scan first. Returns name, path, tokens, hash and risk.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional text to filter by name, description or tag' },
        limit: { type: 'number', description: 'How many rows to return (default 20, max 200)' }
      }
    },
    run: async (args) => listSkills(BASE, String(args.query ?? ''), Math.min(Number(args.limit ?? 20), 200))
  },
  {
    name: 'search',
    description: 'Full-text search over skill names, descriptions, tags and bodies. Same search the app runs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number', description: 'How many rows to return (default 20)' }
      },
      required: ['query']
    },
    run: async (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) throw new ServiceError('search needs a query', 2)
      return listSkills(BASE, query, Math.min(Number(args.limit ?? 20), 200))
    }
  },
  {
    name: 'enable',
    description:
      'Switch a skill on for its agent. The package is moved out of the agent\'s .archive if it was parked there. Journals the same entry the UI writes.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name' },
        agent: { type: 'string', description: 'Agent to enable it for; defaults to the agent owning the skill folder' }
      },
      required: ['name']
    },
    run: async (args) => setEnabled(BASE, String(args.name), true, args.agent ? String(args.agent) : undefined)
  },
  {
    name: 'disable',
    description: 'Switch a skill off, moving the package into that agent\'s .archive. Nothing is deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name' },
        agent: { type: 'string', description: 'Agent to disable it for; defaults to the agent owning the skill folder' }
      },
      required: ['name']
    },
    run: async (args) => setEnabled(BASE, String(args.name), false, args.agent ? String(args.agent) : undefined)
  },
  {
    name: 'scan',
    description: 'Rescan every known root so new and changed skills appear. force skips the incremental check.',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'Rescan everything, not only what changed' } }
    },
    run: async (args) => apiPost(BASE, `/api/scan${args.force ? '?force=1' : ''}`, {})
  },
  {
    name: 'lock',
    description:
      'Read the lock, or check it against the library. A check answers ok:false with added/removed/changed when the library drifted.',
    inputSchema: {
      type: 'object',
      properties: { check: { type: 'boolean', description: 'Compare the lock with the library instead of writing it' } }
    },
    run: async (args) => (args.check ? checkLock(BASE) : apiPost(BASE, '/api/lock/write', {}))
  },
  {
    name: 'skill',
    description:
      'One skill in full: version, tags, related skills, health, risk, copy count and any drift. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact skill name' } },
      required: ['name']
    },
    run: async (args) => {
      const skill = await resolveSkill(BASE, String(args.name))
      return skillDetail(BASE, skill.id)
    }
  },
  {
    name: 'improve',
    description:
      'The library audit the app shows in its Improve view: one finding per rule breach, with severity, the skill, the file and a sentence saying what is wrong. Read-only, and the same rules the app runs.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'Only findings at this severity: error, warn or info' },
        skill: { type: 'string', description: 'Only findings for this exact skill name' },
        limit: { type: 'number', description: 'How many findings to return (default 50)' }
      }
    },
    run: async (args) => {
      const report = await improveFindings(BASE)
      const severity = args.severity ? String(args.severity) : ''
      const skill = args.skill ? String(args.skill) : ''
      const findings = report.findings
        .filter((finding) => (!severity || finding.severity === severity) && (!skill || finding.skill === skill))
        .slice(0, Math.min(Number(args.limit ?? 50), 200))
      return { roots: report.roots.length, total: report.findings.length, summary: report.summary, findings }
    }
  },
  {
    name: 'consolidate',
    description:
      'Groups of skills that look like copies of each other, with the verdict the app gives: near duplicate, partial overlap, intentional family, shape only, weak evidence or cross-root placement. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        mergeType: { type: 'string', description: 'Only groups with this verdict' },
        limit: { type: 'number', description: 'How many groups to return (default 20)' }
      }
    },
    run: async (args) => {
      const report = await consolidateGroups(BASE)
      const mergeType = args.mergeType ? String(args.mergeType) : ''
      const groups = report.groups
        .filter((group) => !mergeType || group.mergeType === mergeType)
        .slice(0, Math.min(Number(args.limit ?? 20), 120))
      return { scanned: report.scanned, summary: report.summary, total: report.groups.length, groups }
    }
  },
  {
    name: 'curate',
    description:
      'What has aged and what overlaps: skills whose folder has not changed in N days, plus duplicate, variant, near-duplicate and family-overload clusters. Age is the last edit, not usage, and the app cannot see who loaded a skill. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        staleDays: { type: 'number', description: 'Minimum days since the last edit (default 90)' },
        limit: { type: 'number', description: 'How many rows per list to return (default 20)' }
      }
    },
    run: async (args) => {
      const report = await curationReport(BASE)
      const days = Number(args.staleDays ?? 90)
      const limit = Math.min(Number(args.limit ?? 20), 200)
      return {
        scanned: report.scanned,
        stale: report.stale.filter((row) => row.daysSinceModified >= days).slice(0, limit),
        clusters: report.groups.slice(0, limit),
        similar: report.similar.slice(0, limit)
      }
    }
  }
]

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

async function handle(message: { id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<void> {
  const { id, method, params } = message
  // A notification has no id and takes no reply. `notifications/initialized` is the common one.
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO
    })
    return
  }
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, {
      tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    })
    return
  }
  if (method === 'tools/call') {
    const name = String(params?.name ?? '')
    const args = (params?.arguments ?? {}) as Record<string, unknown>
    const tool = TOOLS.find((entry) => entry.name === name)
    if (!tool) {
      fail(id, -32602, `unknown tool "${name}". Available: ${TOOLS.map((entry) => entry.name).join(', ')}`)
      return
    }
    try {
      reply(id, text(await tool.run(args)))
    } catch (error) {
      // A tool failure is a tool result with isError, not a transport error: the client should see
      // what went wrong (an ambiguous name, a service that is down) without losing the session.
      reply(id, {
        isError: true,
        content: [{ type: 'text', text: (error as Error).message }]
      })
    }
    return
  }
  if (method && method.startsWith('notifications/')) return
  if (isNotification) return
  fail(id, -32601, `method not found: ${method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
    if (!line) continue
    let parsed: { id?: unknown; method?: string; params?: Record<string, unknown> }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      fail(null, -32700, 'parse error')
      continue
    }
    void handle(parsed)
  }
})
process.stdin.on('end', () => process.exit(0))
