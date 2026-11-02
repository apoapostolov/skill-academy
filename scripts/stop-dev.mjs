#!/usr/bin/env node
// Stops the dev loop started by `npm run service` (or `npm run dev`) using its pid file.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pidFile = path.join(os.homedir(), '.skill-academy', 'dev.pid')
if (!fs.existsSync(pidFile)) {
  console.log('No dev loop is running.')
  process.exit(0)
}

const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
if (!pid) {
  fs.rmSync(pidFile, { force: true })
  console.log('Pid file was empty; removed it.')
  process.exit(0)
}

if (process.platform === 'win32') {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' })
} else {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    process.kill(pid, 'SIGTERM')
  }
}

fs.rmSync(pidFile, { force: true })
console.log(`Stopped the dev loop (pid ${pid}).`)
