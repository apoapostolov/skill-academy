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

/**
 * Windows stores a credential as a UTF-16 blob and refuses anything past 2560 characters, which a
 * Codex session (access + refresh + id token) exceeds. A long secret is therefore split across
 * numbered entries under the same service, with the header entry recording how many parts there
 * are. It stays in the credential store; it is never spilled to a file.
 */
// The Win32 blob limit is 2560 BYTES, which is about 1280 UTF-16 characters, not 2560 characters.
const CHUNK = 1100
const PART = (provider: string, index: number) => `${provider}#${index}`

export function setLongSecret(provider: string, value: string): void {
  if (value.length <= CHUNK) {
    setKey(provider, value)
    for (let index = 1; index <= 8; index += 1) deleteKey(PART(provider, index))
    return
  }
  const parts = Math.ceil(value.length / CHUNK)
  for (let index = 0; index < parts; index += 1) {
    entry(PART(provider, index + 1)).setPassword(value.slice(index * CHUNK, (index + 1) * CHUNK))
  }
  for (let index = parts + 1; index <= parts + 8; index += 1) deleteKey(PART(provider, index))
  entry(provider).setPassword(`parts:${parts}:${value.length}`)
}

export function getLongSecret(provider: string): string | null {
  const header = getKey(provider)
  if (!header) return null
  const match = /^parts:(\d+):(\d+)$/.exec(header)
  if (!match) return header
  const parts = Number(match[1])
  const expected = Number(match[2])
  const pieces: string[] = []
  for (let index = 1; index <= parts; index += 1) {
    const piece = getKey(PART(provider, index))
    if (piece === null) return null
    pieces.push(piece)
  }
  const joined = pieces.join('')
  return joined.length === expected ? joined : null
}

export function deleteLongSecret(provider: string): void {
  const header = getKey(provider)
  const match = header ? /^parts:(\d+):(\d+)$/.exec(header) : null
  if (match) {
    for (let index = 1; index <= Number(match[1]); index += 1) deleteKey(PART(provider, index))
  }
  deleteKey(provider)
}

export function keyStatus(provider: string): { configured: boolean; hint: string | null } {
  const key = getKey(provider)
  if (!key) return { configured: false, hint: null }
  return { configured: true, hint: key.length > 4 ? `…${key.slice(-4)}` : '…' }
}
