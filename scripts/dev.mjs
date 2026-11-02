#!/usr/bin/env node
// One supervisor for the dev loop: API service (tsx watch) + Vite client (HMR).
// Stops both on Ctrl+C or when either dies. Output is prefixed so the two streams
// stay readable in one terminal.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_PORT = process.env.SKILL_ACADEMY_APP_PORT ?? '4319'
const API_PORT = process.env.SKILL_ACADEMY_API_PORT ?? '4320'

const STATE_DIR = path.join(os.homedir(), '.skill-academy')
const LOG_FILE = path.join(STATE_DIR, 'logs', 'dev.log')
const PID_FILE = path.join(STATE_DIR, 'dev.pid')

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' })

/** Every line goes to the terminal and to the log, so a hidden run is still readable. */
function out(line, stream = process.stdout) {
  stream.write(line)
  logStream.write(line.replace(/\x1b\[\d+m/g, ''))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (fs.existsSync(PID_FILE)) {
  const previous = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
  if (previous && previous !== process.pid && alive(previous)) {
    console.error(`Skill Academy dev loop already running (pid ${previous}). Use "npm run stop" first.`)
    process.exit(1)
  }
}
fs.writeFileSync(PID_FILE, String(process.pid))

const children = []
let shuttingDown = false

function run(name, color, command) {
  // The command strings are literals defined in this file; nothing from the
  // environment or the user is interpolated into them, and the port is coerced
  // through the environment only as a number. shell:true exists solely because
  // npm is a .cmd shim on Windows.
  const child = spawn(command, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SKILL_ACADEMY_API_PORT: API_PORT }
  })
  children.push(child)

  const prefix = `\x1b[${color}m[${name}]\x1b[0m `
  const write = (stream) => (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) stream.write(prefix + line + '\n')
    }
  }
  child.stdout.on('data', write(process.stdout))
  child.stderr.on('data', write(process.stderr))

  child.on('exit', (code) => {
    if (shuttingDown) return
    out(`\n${prefix}exited with code ${code}. Stopping the other process.\n`, process.stderr)
    shutdown(code ?? 1)
  })
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  fs.rmSync(PID_FILE, { force: true })
  setTimeout(() => process.exit(code), 200)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('api', '36', 'npm run dev:server')
run('web', '35', 'npm run dev:web')

console.log('')
out('  Skill Academy dev loop\n')
out(`  app   http://127.0.0.1:${APP_PORT}\n`)
out(`  api   http://127.0.0.1:${API_PORT}/api/state\n`)
out(`  dev   http://127.0.0.1:${APP_PORT}/dev\n`)
out(`  log   ${LOG_FILE}\n`)
out('')
