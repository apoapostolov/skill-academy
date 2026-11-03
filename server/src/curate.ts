import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './db'
import { compositeTargets } from './links'

/**
 * Deterministic curation. No model, no network: clusters are built from what the index already
 * knows, so the report can be argued with line by line. The LLM pass later works on top of this.
 */

export type ClusterKind = 'duplicate' | 'variant' | 'near-duplicate' | 'family-overload'

export interface CurationMember {
  id: number
  name: string
  path: string
  root: string
  version: string | null
  tokens: number
  hash: string
}

export interface CurationGroup {
  kind: ClusterKind
  key: string
  members: CurationMember[]
  evidence: string
  action: 'merge' | 'keep-one' | 'review'
  keep?: number
}

interface Row {
  id: number
  name: string
  description: string | null
  path: string
  root_path: string
  tags: string | null
  category: string | null
  tokens: number
  package_hash: string | null
}

function rows(): Row[] {
  // Linked skills are composites: curation may read them, never propose them for a merge.
  const composite = compositeTargets()
  return (getDb()
    .prepare(
      `SELECT id, name, description, path, root_path, tags, category, tokens, package_hash
       FROM skills ORDER BY name COLLATE NOCASE`
    )
    .all() as unknown as Row[]).filter((row) => !composite.has(row.path))
}

function versionOf(path: string): string | null {
  try {
    const text = readFileSync(join(path, 'SKILL.md'), 'utf8')
    const match = /^version:\s*(.+)$/m.exec(text.slice(0, 1500))
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null
  } catch {
    return null
  }
}

/** Words that carry no curation signal. Kept short on purpose: this is not a stemmer. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'when', 'your', 'you', 'use', 'used', 'using',
  'skill', 'skills', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'are', 'it', 'as', 'by', 'or', 'be',
  'any', 'all', 'into', 'than', 'then', 'about', 'their', 'them', 'they', 'which', 'while', 'so'
])

function bag(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word))
  return new Set(words)
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

function member(row: Row): CurationMember {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    root: row.root_path,
    version: versionOf(row.path),
    tokens: row.tokens,
    hash: (row.package_hash ?? '').slice(0, 12)
  }
}

function bestKeep(list: Row[]): number {
  // Keep the copy with the most content, because a merge should start from the fullest text.
  const sorted = [...list].sort((a, b) => b.tokens - a.tokens)
  return sorted[0].id
}

export function curateDryRun(): {
  groups: CurationGroup[]
  similar: Array<{ a: string; b: string; score: number }>
  scanned: number
  ms: number
  summary: Record<ClusterKind, number>
} {
  const started = Date.now()
  const all = rows()
  const groups: CurationGroup[] = []
  const claimed = new Set<string>()

  // 1. Identical bytes under different paths: the same skill installed more than once.
  const byHash = new Map<string, Row[]>()
  for (const row of all) {
    if (!row.package_hash) continue
    const key = row.package_hash
    const bucket = byHash.get(key) ?? []
    bucket.push(row)
    byHash.set(key, bucket)
  }
  for (const [hash, bucket] of byHash) {
    if (bucket.length < 2) continue
    const names = new Set(bucket.map((row) => row.name.toLowerCase()))
    groups.push({
      kind: names.size === 1 ? 'duplicate' : 'near-duplicate',
      key: hash.slice(0, 12),
      members: bucket.map(member),
      evidence:
        names.size === 1
          ? `${bucket.length} copies of ${bucket[0].name} with identical content`
          : `identical content published under ${names.size} names`,
      action: 'keep-one',
      keep: bestKeep(bucket)
    })
    claimed.add(hash.slice(0, 12))
  }

  // 2. Same name, different bytes: a variant that has to be read before anything is merged.
  const byName = new Map<string, Row[]>()
  for (const row of all) {
    const key = row.name.toLowerCase()
    const bucket = byName.get(key) ?? []
    bucket.push(row)
    byName.set(key, bucket)
  }
  for (const [name, bucket] of byName) {
    if (bucket.length < 2) continue
    const hashes = new Set(bucket.map((row) => row.package_hash ?? ''))
    if (hashes.size === 1) continue
    groups.push({
      kind: 'variant',
      key: name,
      members: bucket.map(member),
      evidence: `${bucket.length} copies named ${name} with ${hashes.size} different contents`,
      action: 'review',
      keep: bestKeep(bucket)
    })
  }

  // 3. Different names, near-identical descriptions: likely the same idea written twice.
  // The closest pairs are reported even when they fall short, so the threshold can be judged
  // against real text instead of being taken on faith.
  const bags = all.map((row) => bag(`${row.description ?? ''} ${row.name}`))
  const closest: Array<{ a: string; b: string; score: number }> = []
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].name.toLowerCase() === all[i + 1]?.name.toLowerCase()) continue
    for (let j = i + 1; j < all.length; j += 1) {
      if (all[i].name.toLowerCase() === all[j].name.toLowerCase()) continue
      if (all[i].package_hash && all[i].package_hash === all[j].package_hash) continue
      const score = jaccard(bags[i], bags[j])
      if (score >= 0.35) closest.push({ a: all[i].name, b: all[j].name, score: Number(score.toFixed(3)) })
      if (score < 0.72) continue
      groups.push({
        kind: 'near-duplicate',
        key: `${all[i].name}~${all[j].name}`,
        members: [member(all[i]), member(all[j])],
        evidence: `description overlap ${(score * 100).toFixed(0)}%`,
        action: 'review',
        keep: bestKeep([all[i], all[j]])
      })
      if (groups.length > 400) break
    }
    if (groups.length > 400) break
  }

  // 4. One family carrying more members than anyone will load at once.
  const byFamily = new Map<string, Row[]>()
  for (const row of all) {
    let tags: string[] = []
    try {
      tags = JSON.parse(row.tags ?? '[]') as string[]
    } catch {
      tags = []
    }
    for (const tag of tags.filter((entry) => entry.startsWith('family:'))) {
      const bucket = byFamily.get(tag) ?? []
      bucket.push(row)
      byFamily.set(tag, bucket)
    }
  }
  for (const [family, bucket] of byFamily) {
    if (bucket.length < 12) continue
    groups.push({
      kind: 'family-overload',
      key: family,
      members: bucket.slice(0, 20).map(member),
      evidence: `${bucket.length} skills share ${family}, more than one pass can hold`,
      action: 'review'
    })
  }

  const summary: Record<ClusterKind, number> = {
    duplicate: 0,
    variant: 0,
    'near-duplicate': 0,
    'family-overload': 0
  }
  for (const group of groups) summary[group.kind] += 1

  closest.sort((left, right) => right.score - left.score)
  return {
    groups,
    similar: closest.slice(0, 12),
    scanned: all.length,
    ms: Date.now() - started,
    summary
  }
}
