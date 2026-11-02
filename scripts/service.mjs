#!/usr/bin/env node
// Starts the dev loop fully detached and hidden.
//
// spawn(detached) is not enough on Windows: the child still shares the parent's
// console, so closing the terminal (or the tool that launched it) sends CTRL_C to
// the whole tree — which is exactly how the first attempt died. A WScript launcher
// with window style 0 creates a process with no console at all.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const stateDir = path.join(os.homedir(), '.skill-academy')
const logPath = path.join(stateDir, 'logs', 'dev.log')
const pidFile = path.join(stateDir, 'dev.pid')
const launcher = path.join(stateDir, 'start-dev.vbs')
const devScript = path.join(repo, 'scripts', 'dev.mjs')

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

if (process.platform === 'win32') {
  // Inner quotes are doubled inside a VBScript string literal.
  const quote = (value) => `"${value.replace(/"/g, '""')}"`
  const command = `${quote(process.execPath)} ${quote(devScript)}`
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
  const child = spawn(process.execPath, [devScript], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env
  })
  child.unref()
}

console.log('Skill Academy is starting in the background.')
console.log('  app  http://127.0.0.1:4319')
console.log('  dev  http://127.0.0.1:4319/dev')
console.log(`  log  ${logPath}`)
console.log('  stop npm run stop')
