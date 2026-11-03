import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const APP_VERSION = '0.1.0-p1'
export const HOST = '127.0.0.1'
export const API_PORT = Number(process.env.SKILL_ACADEMY_API_PORT ?? 10008)

/** Repository root: server/src -> server -> repo */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

/**
 * File watching is a development convenience, not a requirement: the scan still runs at
 * startup and on the periodic sweep. Set SKILL_ACADEMY_WATCH=1 to switch it back on.
 */
export const WATCH_ENABLED = process.env.SKILL_ACADEMY_WATCH === '1'

export const DATA_DIR = process.env.SKILL_ACADEMY_DATA ?? path.join(os.homedir(), '.skill-academy')
export const DB_PATH = path.join(DATA_DIR, 'index.db')
export const LOG_DIR = path.join(DATA_DIR, 'logs')
/** Installed skill packages live here; a test run can point it at a temporary directory. */
export const LIBRARY_DIR = process.env.SKILL_ACADEMY_LIBRARY ?? path.join(DATA_DIR, 'library')

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(LOG_DIR, { recursive: true })
