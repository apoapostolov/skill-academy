import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config'

/**
 * Per-provider tweaks that are safe to keep on disk: a base URL and a discovered model list.
 * No credential ever reaches this file; keys live in the OS credential store.
 */

export interface ProviderOverride {
  base?: string
  models?: string[]
  /** When the model list was last fetched, so a list can be reused for 48 hours. */
  modelsAt?: string
}

const FILE = path.join(DATA_DIR, 'providers.json')

function load(): Record<string, ProviderOverride> {
  try {
    if (!existsSync(FILE)) return {}
    return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, ProviderOverride>
  } catch {
    return {}
  }
}

export function getOverride(id: string): ProviderOverride {
  return load()[id] ?? {}
}

export function setOverride(id: string, patch: ProviderOverride): ProviderOverride {
  const all = load()
  const next = { ...(all[id] ?? {}), ...patch }
  if (next.base === '') delete next.base
  if (next.models && next.models.length === 0) delete next.models
  all[id] = next
  mkdirSync(path.dirname(FILE), { recursive: true })
  writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
  return next
}

export function overridesPath(): string {
  return FILE
}
