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
  consolidateGroups,
  curationReport,
  improveFindings,
  listSkills,
  resolveSkill,
  setEnabled,
  skillDetail
} from './api'

interface Options {
  base: string
  json: boolean
  limit: number
  agent?: string
  force: boolean
  check: boolean
  file?: string
  severity?: string
  days: number
  rest: string[]
}

function parse(argv: string[]): { command: string; options: Options } {
  const options: Options = { base: DEFAULT_BASE, json: false, limit: 20, force: false, check: false, days: 90, rest: [] }
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
    else if (arg === '--severity') options.severity = argv[++index]
    else if (arg === '--days') options.days = Number(argv[++index] ?? 90)
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
    out('  skill <name>            one skill with tags, related skills, health and drift')
    out('  improve [--severity s]  the library audit: one line per rule breach')
    out('  consolidate             groups that look like copies of each other')
    out('  curate [--days n]       what has aged and what overlaps')
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

  if (command === 'skill') {
    const name = options.rest[0]
    if (!name) throw new ServiceError('skill needs a name', 2)
    const row = await resolveSkill(options.base, name)
    const detail = await skillDetail(options.base, row.id)
    if (options.json) {
      out(JSON.stringify(detail, null, 2))
      return 0
    }
    out(`${detail.name}  v${detail.version ?? '—'}`)
    out(`  path     ${detail.path}`)
    out(`  risk     ${detail.risk}`)
    out(`  tags     ${detail.tags.length ? detail.tags.join(', ') : 'none'}`)
    out(`  related  ${detail.related_skills.length ? detail.related_skills.join(', ') : 'none'}`)
    out(`  health   ${detail.health.length ? `${detail.health.length} issue(s)` : 'clean'}`)
    if (detail.copyCount && detail.copyCount > 1) out(`  copies   ${detail.copyCount}`)
    if (detail.drift) out(`  behind   v${detail.drift.latestVersion} exists in another root`)
    if (detail.sameVersionDrift?.length) out(`  drift    ${detail.sameVersionDrift.length} copy at the same version with different bytes`)
    return 0
  }

  if (command === 'improve') {
    const report = await improveFindings(options.base)
    const severity = options.severity
    const findings = report.findings.filter((finding) => !severity || finding.severity === severity)
    if (options.json) {
      out(JSON.stringify({ scanned: report.scanned, total: report.findings.length, findings }, null, 2))
      return 0
    }
    out(`${findings.length} of ${report.findings.length} findings across ${report.roots.length} roots`)
    for (const finding of findings.slice(0, options.limit)) {
      out(`  ${finding.severity.padEnd(5)} ${finding.rule.padEnd(22)} ${finding.skill}  ${finding.detail}`)
    }
    if (findings.length > options.limit) out(`  … ${findings.length - options.limit} more (use --limit)`)
    return findings.some((finding) => finding.severity === 'error') ? 1 : 0
  }

  if (command === 'consolidate') {
    const report = await consolidateGroups(options.base)
    if (options.json) {
      out(JSON.stringify(report, null, 2))
      return 0
    }
    out(`${report.groups.length} group(s) over ${report.scanned} skills`)
    for (const [kind, count] of Object.entries(report.summary)) out(`  ${kind.padEnd(22)} ${count}`)
    for (const group of report.groups.slice(0, options.limit)) {
      out(`  ${group.mergeType.padEnd(22)} ${group.survivor ?? group.members[0]?.name ?? group.key}  ${group.evidence}`)
    }
    return 0
  }

  if (command === 'curate') {
    const report = await curationReport(options.base)
    const days = options.days
    const stale = report.stale.filter((row) => row.daysSinceModified >= days)
    if (options.json) {
      out(JSON.stringify({ scanned: report.scanned, stale, clusters: report.groups, similar: report.similar }, null, 2))
      return 0
    }
    out(`${stale.length} skill(s) untouched for ${days}+ days, over ${report.scanned} read`)
    // Two copies of one name in different roots are two rows here, so the root is part of the line.
    for (const row of stale.slice(0, options.limit)) {
      const where = row.path.split(/[\/]/).slice(-3, -1).join('/')
      out(`  ${String(row.daysSinceModified).padStart(4)}d  ${row.name.padEnd(34)} ${where}`)
    }
    if (report.groups.length) {
      out(`${report.groups.length} overlap cluster(s)`)
      for (const group of report.groups.slice(0, options.limit)) out(`  ${group.kind.padEnd(18)} ${group.key}`)
    }
    out('age is the last edit, not usage: the app cannot see who loaded a skill')
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
