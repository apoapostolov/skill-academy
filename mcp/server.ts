#!/usr/bin/env node
/**
 * The MCP server: the library an agent can ask about.
 *
 * Six tools, because an agent asking for a skill is the likelier caller than a person in a browser:
 * `list`, `search`, `enable`, `disable`, `scan`, `lock`. It is a thin client over the local service,
 * which stays the source of truth, so an enable from here writes the same journal entry the UI writes.
 *
 * Transport is stdio with newline-delimited JSON-RPC 2.0, which is what MCP clients speak.
 */
import { DEFAULT_BASE, ServiceError, apiPost, checkLock, listSkills, resolveSkill, setEnabled } from '../cli/api'

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
