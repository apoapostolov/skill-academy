import { Entry } from '@napi-rs/keyring'

/**
 * Provider credentials live in the OS credential store, one entry per provider.
 * Nothing here ever writes a key to disk, to the database, to a log or to a response:
 * the renderer only ever learns whether a key exists and its last four characters.
 */

const SERVICE = 'skill-academy'

export class KeyringUnavailable extends Error {
  constructor(cause: string) {
    super(`keyring unavailable: ${cause}`)
  }
}

function entry(provider: string): Entry {
  try {
    return new Entry(SERVICE, `provider:${provider}`)
  } catch (error) {
    // A silent fallback to a plaintext file would be worse than refusing: refuse and say why.
    throw new KeyringUnavailable((error as Error).message)
  }
}

export function setKey(provider: string, key: string): void {
  const value = key.trim()
  if (!value) throw new Error('empty-key')
  entry(provider).setPassword(value)
}

export function getKey(provider: string): string | null {
  try {
    const value = entry(provider).getPassword()
    return value && value.length ? value : null
  } catch {
    return null
  }
}

export function deleteKey(provider: string): boolean {
  try {
    const existing = entry(provider).getPassword()
    if (!existing) return false
    entry(provider).deletePassword()
    return true
  } catch {
    return false
  }
}

/** The only shape of a key that is ever allowed to leave this module. */
export function keyStatus(provider: string): { configured: boolean; hint: string | null } {
  const key = getKey(provider)
  if (!key) return { configured: false, hint: null }
  return { configured: true, hint: key.length > 4 ? `…${key.slice(-4)}` : '…' }
}
