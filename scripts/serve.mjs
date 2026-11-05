#!/usr/bin/env node
// The windowless child: runs the real server with its output on disk.
//
// A launcher that hides the console but drops stdout turns every failure into a silent one. This
// wrapper exists so `start-app.vbs` can stay a one-liner (`sh.Run "node serve.mjs", 0`) and the log
// still gets the reason a start failed.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const logDir = path.join(os.homedir(), '.skill-academy', 'logs')
const logPath = path.join(logDir, 'app.log')
fs.mkdirSync(logDir, { recursive: true })

const fd = fs.openSync(logPath, 'a')
const stamp = new Date().toISOString()
fs.writeSync(fd, `\n--- start ${stamp} ---\n`)

const pidFile = path.join(os.homedir(), '.skill-academy', 'app.pid')
const entry = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const child = spawn(process.execPath, [entry, path.join(repo, 'server', 'src', 'index.ts')], {
  cwd: repo,
  stdio: ['ignore', fd, fd],
  env: process.env
})

// The pid `npm run stop` needs is the one that owns the port, not this wrapper's.
fs.writeFileSync(pidFile, String(child.pid))

child.on('exit', (code, signal) => {
  fs.writeSync(fd, `--- exit ${code ?? signal} ${new Date().toISOString()} ---\n`)
  fs.rmSync(pidFile, { force: true })
  fs.closeSync(fd)
  process.exit(code ?? 1)
})
