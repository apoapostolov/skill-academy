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

// npm is not a project dependency: the old path here assumed `node_modules/npm`, which does not
// exist, so every start died with MODULE_NOT_FOUND before it could serve anything. Resolve the npm
// that actually runs this project, and only build when there is no bundle or the build is asked for.
function npmInvocation() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, args: [process.env.npm_execpath, 'run', 'build'], shell: false }
  }
  const beside = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(beside)) return { command: process.execPath, args: [beside, 'run', 'build'], shell: false }
  // Last resort: let the shell find npm (npm.cmd on Windows).
  return { command: 'npm run build', args: [], shell: true }
}

const bundle = path.join(repo, 'web', 'dist', 'index.html')
const needsBuild = !fs.existsSync(bundle) || process.env.SKILL_ACADEMY_BUILD === '1'
if (needsBuild) {
  const npm = npmInvocation()
  const build = spawnSync(npm.command, npm.args, { cwd: repo, stdio: 'inherit', env: process.env, shell: npm.shell })
  if (build.status !== 0) {
    console.error('build failed; not starting.')
    process.exit(build.status ?? 1)
  }
}

// The server is started through scripts/serve.mjs, which puts its output on disk. Handing node a
// `.cmd` shim, or running the console app directly from a windowless launcher, both produced a
// process that died before printing anything: the service stayed down with an empty log beside it.
const serve = path.join(repo, 'scripts', 'serve.mjs')

if (process.platform === 'win32') {
  const quote = (value) => `"${value.replace(/"/g, '""')}"`
  const launcher = path.join(stateDir, 'start-app.vbs')
  const script = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${quote(repo)}`,
    `sh.Run ${quote(`"${process.execPath}" "${serve}"`)}, 0, False`,
    ''
  ].join(String.fromCharCode(13) + String.fromCharCode(10))
  fs.writeFileSync(launcher, script, 'utf8')
  spawnSync('wscript.exe', [launcher], { stdio: 'ignore' })

  // The launcher is detached and hands back no pid, so the wrapper writes one (scripts/serve.mjs)
  // and the start is confirmed by connecting to the port. Parsing netstat was the first attempt: it
  // answered nothing for a listener curl was talking to, so this asks the port itself.
  const net = await import('node:net')
  const probe = () => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (await probe()) {
      const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : 'unknown'
      console.log(`Skill Academy is listening on ${port} (pid ${pid}).`)
      process.exit(0)
    }
  }

  console.error('it never started listening; the log says why:')
  try {
    const tail = fs.readFileSync(logPath, 'utf8').split(String.fromCharCode(10)).slice(-15).join(String.fromCharCode(10))
    console.error(tail)
  } catch {
    console.error('  (no log file was written)')
  }
  process.exit(1)
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
