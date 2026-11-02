#!/usr/bin/env node
// Runs the product on one port: builds the interface once, then starts the service that
// serves both the API and the built UI. The watcher stays off unless SKILL_ACADEMY_WATCH=1.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const stateDir = path.join(os.homedir(), '.skill-academy')
const logPath = path.join(stateDir, 'logs', 'app.log')
const pidFile = path.join(stateDir, 'app.pid')
const port = process.env.SKILL_ACADEMY_API_PORT ?? '10008'

fs.mkdirSync(path.dirname(logPath), { recursive: true })

if (fs.existsSync(pidFile)) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  let running = false
  try {
    running = pid > 0 && (process.kill(pid, 0), true)
  } catch {
    running = false
  }
  if (running) {
    console.log(`Already running (pid ${pid}). Use "npm run stop" first.`)
    process.exit(0)
  }
  fs.rmSync(pidFile, { force: true })
}

const build = spawnSync(process.execPath, [path.join(repo, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'run', 'build'], {
  cwd: repo,
  stdio: 'inherit',
  env: process.env
})
if (build.status !== 0) {
  console.error('build failed; not starting.')
  process.exit(build.status ?? 1)
}

const tsx = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const command = `"${process.execPath}" "${tsx}" "${path.join(repo, 'server', 'src', 'index.ts')}"`

if (process.platform === 'win32') {
  const quote = (value) => `"${value.replace(/"/g, '""')}"`
  const launcher = path.join(stateDir, 'start-app.vbs')
  const script = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${quote(repo)}`,
    `sh.Run ${quote(command)}, 0, False`,
    ''
  ].join('\r\n')
  fs.writeFileSync(launcher, script, 'utf8')
  spawnSync('wscript.exe', [launcher], { stdio: 'ignore' })
} else {
  const { spawn } = await import('node:child_process')
  const fd = fs.openSync(logPath, 'a')
  const child = spawn(process.execPath, [tsx, path.join(repo, 'server', 'src', 'index.ts')], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env
  })
  child.unref()
  fs.writeFileSync(pidFile, String(child.pid))
}

console.log('Skill Academy is starting on one port.')
console.log(`  app  http://127.0.0.1:${port}`)
console.log(`  log  ${logPath}`)
console.log('  stop npm run stop')
