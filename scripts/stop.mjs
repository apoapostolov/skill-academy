#!/usr/bin/env node
// Stops the service started by `npm run service`.
//
// The pid file is the fast path, but it is written by whoever launched the process, and on Windows
// the launcher is a detached wscript, so a missing pid file must not mean "nothing to stop". The
// listener on the port is the honest source of truth, and that is the fallback.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const stateDir = path.join(os.homedir(), '.skill-academy')
const pidFile = path.join(stateDir, 'app.pid')
const port = Number(process.env.SKILL_ACADEMY_API_PORT ?? '10008')

function listeners(target) {
  const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
  const pids = new Set()
  for (const line of (netstat.stdout ?? '').split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const cells = line.trim().split(/\s+/)
    const local = cells[1] ?? ''
    if (!local.endsWith(':' + target)) continue
    const pid = Number(cells[cells.length - 1])
    if (pid > 0) pids.add(pid)
  }
  return [...pids]
}

const fromFile = []
if (fs.existsSync(pidFile)) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  if (pid > 0) fromFile.push(pid)
  fs.rmSync(pidFile, { force: true })
}

const targets = [...new Set([...fromFile, ...listeners(port)])].filter((pid) => pid !== process.pid)
if (!targets.length) {
  console.log(`nothing is listening on ${port} and there is no pid file: it is already stopped.`)
  process.exit(0)
}

for (const pid of targets) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' })
}
console.log(`stopped ${targets.join(', ')} on ${port}.`)
