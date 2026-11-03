#!/usr/bin/env node
/**
 * `ska` — the thin CLI over the local service.
 *
 * It exists for scripts and SSH: the same routes the browser calls, the same journal entries, no
 * second implementation of the rules. Exit codes are the contract: 0 success, 1 a negative answer
 * (`lock --check` found drift), 2 a usage or connection problem, so `ska lock --check` is usable in CI
 * without parsing prose.
 */
import {
  DEFAULT_BASE,
  ServiceError,
  apiGet,
  apiPost,
  checkLock,
  listSkills,
  resolveSkill,
  setEnabled
} from './api'

interface Options {
  base: string
  json: boolean
  limit: number
  agent?: string
  force: boolean
  check: boolean
  file?: string
  rest: string[]
}

function parse(argv: string[]): { command: string; options: Options } {
  const options: Options = { base: DEFAULT_BASE, json: false, limit: 20, force: false, check: false, rest: [] }
  let command = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--force') options.force = true
    else if (arg === '--check') options.check = true
    else if (arg === '--file') options.file = argv[++index]
    else if (arg === '--base') options.base = argv[++index] ?? options.base
    else if (arg === '--limit') options.limit = Number(argv[++index] ?? 20)
    else if (arg === '--agent') options.agent = argv[++index]
    else if (arg.startsWith('--')) throw new ServiceError(`unknown option ${arg}`, 2)
    else if (!command) command = arg
    else options.rest.push(arg)
  }
  return { command, options }
}

const out = (line: string): void => {
  process.stdout.write(line + '\n')
}

async function main(): Promise<number> {
  const { command, options } = parse(process.argv.slice(2))

  if (!command || command === 'help' || command === '--help') {
    out('ska <command> [options]')
    out('')
    out('  list [query]            skills in the library')
    out('  search <query>          the same search the app runs')
    out('  show <name>             one skill')
    out('  enable <name>           switch a skill on for its agent (or --agent)')
    out('  disable <name>          switch it off, moving it into the agent\'s .archive')
    out('  scan [--force]          rescan the roots')
    out('  lock [--check] [--file] write the lock, or check it against --file and exit 1 on drift')
    out('  status                  what the service thinks it is doing')
    out('')
    out('  --base <url>            service address (default ' + DEFAULT_BASE + ')')
    out('  --json                  machine-readable output')
    return 0
  }

  if (command === 'list' || command === 'search') {
    const query = options.rest.join(' ')
    const { total, rows } = await listSkills(options.base, query, options.limit)
    if (options.json) {
      out(JSON.stringify({ total, rows }, null, 2))
      return 0
    }
    out(`${total} skill${total === 1 ? '' : 's'}${query ? ` matching "${query}"` : ''}`)
    for (const row of rows) out(`  ${row.name.padEnd(34)} ${String(row.tokens).padStart(6)} tok  ${row.path}`)
    return 0
  }

  if (command === 'show') {
    const name = options.rest[0]
    if (!name) throw new ServiceError('show needs a skill name', 2)
    const skill = await resolveSkill(options.base, name)
    const detail = await apiGet<Record<string, unknown>>(options.base, `/api/skills/${skill.id}`)
    out(options.json ? JSON.stringify(detail, null, 2) : `${skill.name}\n  path   ${skill.path}\n  hash   ${skill.package_hash}\n  tokens ${skill.tokens}\n  risk   ${skill.risk}`)
    return 0
  }

  if (command === 'enable' || command === 'disable') {
    const name = options.rest[0]
    if (!name) throw new ServiceError(`${command} needs a skill name`, 2)
    const results = await setEnabled(options.base, name, command === 'enable', options.agent)
    if (options.json) {
      out(JSON.stringify(results, null, 2))
      return 0
    }
    for (const { agent, result } of results) {
      out(`${command === 'enable' ? 'enabled' : 'disabled'} ${name} for ${agent}${result.path ? ` -> ${result.path}` : ''}`)
    }
    return 0
  }

  if (command === 'scan') {
    const result = await apiPost<Record<string, unknown>>(options.base, `/api/scan${options.force ? '?force=1' : ''}`, {})
    out(options.json ? JSON.stringify(result, null, 2) : `scanned: ${JSON.stringify(result)}`)
    return 0
  }

  if (command === 'lock') {
    if (options.check) {
      try {
        // Without a baseline this compares the live lock, which the service keeps current after
        // every scan, so it can only ever agree. CI wants the lock published with the library.
        // A drifted lock answers 409, which is the answer rather than an error: read it off the
        // response instead of letting it fall through to the top-level handler as a traceback.
        const check = await checkLock(options.base, options.file).catch((error: unknown) => {
          if (error instanceof ServiceError && error.status === 409 && error.body) {
            return error.body as Awaited<ReturnType<typeof checkLock>>
          }
          throw error
        })
        if (options.json) out(JSON.stringify(check, null, 2))
        else {
          out(`lock ${check.ok ? 'matches' : 'has drifted'}: ${check.path}`)
          for (const key of check.added) out(`  added   ${key}`)
          for (const key of check.removed) out(`  removed ${key}`)
          for (const key of check.changed) out(`  changed ${key}`)
        }
        return check.ok ? 0 : 1
      } catch (error) {
        // A missing lock is drift too: CI must not pass because nobody wrote one.
        if (error instanceof ServiceError && error.status === 404) {
          out('no lock file: run `ska lock` first')
          return 1
        }
        throw error
      }
    }
    const written = await apiPost<{ written: string; skills: number }>(options.base, '/api/lock/write', {})
    out(options.json ? JSON.stringify(written, null, 2) : `lock written: ${written.written} (${written.skills} skills)`)
    return 0
  }

  if (command === 'status') {
    const state = await apiGet<Record<string, unknown>>(options.base, '/api/state')
    out(options.json ? JSON.stringify(state, null, 2) : JSON.stringify(state, null, 2))
    return 0
  }

  throw new ServiceError(`unknown command "${command}"`, 2)
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const known = error instanceof ServiceError
    process.stderr.write(`ska: ${(error as Error).message}\n`)
    process.exit(known && error.status === 2 ? 2 : known && error.status === 0 ? 2 : 1)
  })
