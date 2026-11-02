import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { getDb } from './db'

/**
 * Consolidate, built to `skill-consolidation`'s rules rather than to a similarity score.
 *
 * Three merge types exist there and nothing else:
 *   near-duplicate  same territory, same rules, one newer rewrite  → survivor keeps its name and
 *                   version, the loser becomes a pointer skill
 *   partial overlap shared territory, each body has unique lanes    → never pointerize; the
 *                   largest, most battle-worn body stays canonical and the others become routers
 *   intentional family router plus children, each triggered on its own → left alone
 *
 * The gate that matters: "never merge on descriptions or blob similarity alone". So a cluster is
 * only proposed when the bodies are read, and a description match with no body evidence is
 * reported as `weak-evidence` and cannot be applied.
 */

export type MergeType =
  | 'near-duplicate'
  | 'partial-overlap'
  | 'intentional-family'
  | 'weak-evidence'
  | 'cross-root-placement'
  | 'shape-only'

export interface Body {
  dir: string
  name: string
  description: string
  version: string | null
  chars: number
  headings: string[]
  rules: string[]
  references: string[]
  /** Skills this body tells the reader to load, which is how a router announces itself. */
  loads: string[]
  hash: string
}

export interface ConsolidateMember {
  name: string
  path: string
  version: string | null
  chars: number
  hash: string
  uniqueHeadings: string[]
  missingHeadings: string[]
  supportFiles: number
}

export interface ConsolidateGroup {
  key: string
  mergeType: MergeType
  evidence: string
  survivor: string | null
  members: ConsolidateMember[]
  /** Present only when the group is safe to apply. */
  plan: null | {
    survivor: string
    pointerize: Array<{ name: string; body: string }>
    routerize: Array<{ name: string; outline: string[] }>
    rewire: string[]
    verification: string[]
  }
  blocked: string | null
}

const SKIP = new Set(['__pycache__', 'node_modules', 'scripts', 'references', 'templates', 'assets'])

function frontmatter(file: string): { fm: Record<string, string>; body: string } {
  const text = readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const block = match?.[1] ?? ''
  const fm: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const hit = /^([a-z_]+):\s*(.*)$/i.exec(line)
    if (hit) fm[hit[1]] = hit[2].trim().replace(/^["']|["']$/g, '')
  }
  return { fm, body: text.slice(match ? match[0].length : 0) }
}

export function bodyOf(dir: string): Body | null {
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  const { fm, body } = frontmatter(file)
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) => match[1].trim().toLowerCase())
  // A rule is a bullet that asserts something, which is what a merge must not lose.
  const rules = body
    .split(/\r?\n/)
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((line) => line.length > 24)
  const references = [...body.matchAll(/(?:references|scripts|assets)\/([\w.-]+)/g)].map((match) => match[1])
  const loads = [...body.matchAll(/load\s+(?:the\s+)?`?([a-z0-9-]{3,})`?/gi)].map((match) => match[1].toLowerCase())
  let supportFiles = 0
  for (const sub of ['references', 'scripts', 'assets', 'templates']) {
    const full = path.join(dir, sub)
    if (existsSync(full) && statSync(full).isDirectory()) supportFiles += readdirSync(full).length
  }
  return {
    dir,
    name: path.basename(dir),
    description: fm.description ?? '',
    version: fm.version ?? null,
    chars: body.trim().length,
    headings: [...new Set(headings)],
    rules: [...new Set(rules)],
    references: [...new Set(references)],
    loads: [...new Set(loads)],
    hash: hashOf(file)
  }
}

function hashOf(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
}

function collect(rootPath: string): Body[] {
  const out: Body[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP.has(entry)) continue
      const full = path.join(dir, entry)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      if (existsSync(path.join(full, 'SKILL.md'))) {
        const body = bodyOf(full)
        if (body) out.push(body)
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(rootPath, 0)
  return out
}

function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const set = new Set(b)
  const shared = a.filter((entry) => set.has(entry)).length
  return shared / Math.max(a.length, b.length)
}

function difference(a: string[], b: string[]): string[] {
  const set = new Set(b)
  return a.filter((entry) => !set.has(entry))
}

function member(body: Body, others: Body[]): ConsolidateMember {
  const otherHeadings = others.flatMap((entry) => entry.headings)
  const otherRules = others.flatMap((entry) => entry.rules)
  let supportFiles = 0
  for (const sub of ['references', 'scripts', 'assets', 'templates']) {
    const full = path.join(body.dir, sub)
    if (existsSync(full) && statSync(full).isDirectory()) supportFiles += readdirSync(full).length
  }
  return {
    name: body.name,
    path: body.dir,
    version: body.version,
    chars: body.chars,
    hash: body.hash,
    uniqueHeadings: difference(body.headings, otherHeadings),
    missingHeadings: difference(otherHeadings, body.headings).slice(0, 12),
    supportFiles
  }
}

/** The pointer skill body, in the exact shape `skill-consolidation` describes. */
function pointerBody(loser: Body, winner: Body): string {
  const own = loser.headings.filter((heading) => !winner.headings.includes(heading))
  const kept = own.length ? `Nothing outside this pointer was unique: ${own.join(', ')} now live in \`${winner.name}\`.` : `Nothing unique was dropped: every rule here already lives in \`${winner.name}\`.`
  return [
    `# ${loser.name}`,
    '',
    `Merged into \`${winner.name}\`, load that.`,
    '',
    `\`${winner.name}\` owns ${winner.headings.slice(0, 6).map((heading) => `“${heading}”`).join(', ')}.`,
    '',
    kept,
    '',
    '## Related',
    '',
    `- \`${winner.name}\``,
    ''
  ].join('\n')
}

/**
 * A name that appears once in each of several agent roots is a placement, not a duplicate: the same
 * skill is being served to different agents, and merging those deletes the copy one agent reads.
 * Only copies inside one root can be consolidated.
 */
function acrossRoots(members: Body[]): boolean {
  const roots = new Set(
    members.map((member) => {
      const parts = member.dir.split(/[\/]/)
      const skillsAt = parts.lastIndexOf('skills')
      return skillsAt > 0 ? parts.slice(0, skillsAt + 1).join('/') : parts.slice(0, 2).join('/')
    })
  )
  return roots.size > 1
}

export function consolidateDryRun(): {
  groups: ConsolidateGroup[]
  summary: Record<MergeType, number>
  scanned: number
  roots: string[]
  ms: number
} {
  const started = Date.now()
  const roots = (getDb()
    .prepare('SELECT DISTINCT root_path FROM skills ORDER BY root_path')
    .all() as Array<{ root_path: string }>).map((row) => row.root_path)

  const bodies: Body[] = []
  for (const root of roots) bodies.push(...collect(root))

  const byName = new Map<string, Body[]>()
  const byHash = new Map<string, Body[]>()
  for (const body of bodies) {
    const name = body.name.toLowerCase()
    byName.set(name, [...(byName.get(name) ?? []), body])
    byHash.set(body.hash, [...(byHash.get(body.hash) ?? []), body])
  }

  const groups: ConsolidateGroup[] = []
  const seen = new Set<string>()

  // Same name: either identical bytes (a plain duplicate) or a real variant that has to be read.
  for (const [name, copies] of byName) {
    if (copies.length < 2) continue
    const hashes = new Set(copies.map((copy) => copy.hash))
    const key = `name:${name}`
    seen.add(key)
    if (acrossRoots(copies)) {
      groups.push({
        key,
        mergeType: 'cross-root-placement',
        evidence: `${name} is installed in ${new Set(copies.map((copy) => copy.dir.split(/[\/]/).slice(0, -1).join('/'))).size} agent roots; that is distribution, not duplication`,
        survivor: null,
        members: copies.map((copy) => member(copy, copies.filter((other) => other !== copy))),
        plan: null,
        blocked: 'the same skill is served to different agents: merging would delete the copy one agent reads'
      })
      continue
    }

    const sorted = [...copies].sort((a, b) => b.chars - a.chars)
    const survivor = sorted[0]
    const rest = sorted.slice(1)

    if (hashes.size === 1) {
      groups.push({
        key,
        mergeType: 'near-duplicate',
        evidence: `${copies.length} copies of ${name} are byte-identical (${survivor.hash}); one body, several homes`,
        survivor: survivor.name,
        members: copies.map((copy) => member(copy, copies.filter((other) => other !== copy))),
        plan: {
          survivor: survivor.name,
          pointerize: rest.map((copy) => ({ name: copy.name, body: pointerBody(copy, survivor) })),
          routerize: [],
          rewire: [name],
          verification: ['skill_view the survivor and every pointer', 'grep the tree for the merged name', 'confirm no support file went missing']
        },
        blocked: null
      })
      continue
    }

    // Bodies differ. Decide by what each carries that the other does not.
    const uniqueInRest = rest.some((copy) => difference(copy.headings, [survivor].flatMap((s) => s.headings)).length > 0)
    const bigOverlap = overlap(survivor.headings, rest.flatMap((copy) => copy.headings))
    const mergeType: MergeType = uniqueInRest ? 'partial-overlap' : 'near-duplicate'
    groups.push({
      key,
      mergeType,
      evidence:
        `${copies.length} copies named ${name} with ${hashes.size} different bodies; ` +
        `heading overlap ${(bigOverlap * 100).toFixed(0)}%, ` +
        (uniqueInRest ? 'at least one copy carries sections the survivor lacks, so the merge is a router pass, not a pointer pass' : 'no copy carries a section the survivor lacks'),
      survivor: survivor.name,
      members: copies.map((copy) => member(copy, copies.filter((other) => other !== copy))),
      plan:
        mergeType === 'near-duplicate'
          ? {
              survivor: survivor.name,
              pointerize: rest.map((copy) => ({ name: copy.name, body: pointerBody(copy, survivor) })),
              routerize: [],
              rewire: [name],
              verification: ['skill_view the survivor and every pointer', 'grep the tree for the merged name']
            }
          : {
              survivor: survivor.name,
              pointerize: [],
              routerize: rest.map((copy) => ({
                name: copy.name,
                outline: [
                  `canonical pointer block first: load \`${survivor.name}\``,
                  ...difference(copy.headings, survivor.headings).map((heading) => `unique section: ${heading}`),
                  'Related pointing at the canonical',
                  `References table keeps every support file this skill owns (${member(copy, [survivor]).supportFiles} file(s))`,
                  'bump this skill version, because the body changed'
                ]
              })),
              rewire: [name],
              verification: [
                'read both bodies end to end before applying',
                'skill_view every rewritten skill',
                'dangling support-file check per touched skill',
                `bump the version of each rewritten router`
              ]
            },
      blocked: null
    })
  }

  // Different names, identical bytes: the same skill published twice under two names.
  for (const [hash, copies] of byHash) {
    if (copies.length < 2) continue
    const names = new Set(copies.map((copy) => copy.name.toLowerCase()))
    if (names.size === 1) continue
    const key = `hash:${hash}`
    if (seen.has(key)) continue
    const sorted = [...copies].sort((a, b) => b.chars - a.chars)
    groups.push({
      key,
      mergeType: 'near-duplicate',
      evidence: `${hash} is carried by ${names.size} different names: ${[...names].join(', ')}`,
      survivor: sorted[0].name,
      members: copies.map((copy) => member(copy, copies.filter((other) => other !== copy))),
      plan: {
        survivor: sorted[0].name,
        pointerize: sorted.slice(1).map((copy) => ({ name: copy.name, body: pointerBody(copy, sorted[0]) })),
        routerize: [],
        rewire: [...names],
        verification: ['confirm the two names really were the same territory before pointerizing', 'update this skill description, because the trigger moved']
      },
      blocked: null
    })
  }

  // Bodies that are mostly the same text under different names: propose, but never apply unread.
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const left = bodies[i]
      const right = bodies[j]
      if (left.name.toLowerCase() === right.name.toLowerCase()) continue
      if (left.hash === right.hash) continue
      const headingScore = overlap(left.headings, right.headings)
      const ruleScore = overlap(left.rules, right.rules)
      if (headingScore < 0.6 && ruleScore < 0.5) continue

      // A router is architecture, not duplication: leave a family alone.
      const sameFamilyRouters =
        left.loads.includes(right.name.toLowerCase()) || right.loads.includes(left.name.toLowerCase())
      const key = `body:${left.name}~${right.name}`
      const larger = left.chars >= right.chars ? left : right
      const smaller = larger === left ? right : left
      const unique = difference(smaller.headings, larger.headings)
      // A shared skeleton is not shared content: identical headings with almost no rule in common
      // describes two different skills written to the same shape, and merging one into the other
      // would delete a subject.
      const shapeOnly = !sameFamilyRouters && ruleScore < 0.5
      const mergeType: MergeType = sameFamilyRouters
        ? 'intentional-family'
        : shapeOnly
          ? 'shape-only'
          : unique.length
            ? 'partial-overlap'
            : 'near-duplicate'
      groups.push({
        key,
        mergeType,
        evidence:
          `heading overlap ${(headingScore * 100).toFixed(0)}%, rule overlap ${(ruleScore * 100).toFixed(0)}%; ` +
          (sameFamilyRouters ? `\`${smaller.name}\` tells the reader to load \`${larger.name}\`, which is a router` : unique.length ? `\`${smaller.name}\` carries ${unique.length} section(s) the larger body lacks` : 'no unique section, so the smaller body is a rewrite'),
        survivor: mergeType === 'intentional-family' ? null : larger.name,
        members: [member(left, [right]), member(right, [left])],
        plan:
          mergeType === 'intentional-family' || mergeType === 'shape-only'
            ? null
            : {
                survivor: larger.name,
                pointerize: mergeType === 'near-duplicate' ? [{ name: smaller.name, body: pointerBody(smaller, larger) }] : [],
                routerize:
                  mergeType === 'partial-overlap'
                    ? [
                        {
                          name: smaller.name,
                          outline: [
                            `canonical pointer block first: load \`${larger.name}\``,
                            ...unique.map((heading) => `unique section: ${heading}`),
                            'Related pointing at the canonical',
                            'References table keeps every support file this skill owns',
                            'bump this skill version'
                          ]
                        }
                      ]
                    : [],
                rewire: [smaller.name],
                verification: ['read both bodies end to end before applying', 'skill_view the survivor and the rewrite']
              },
        blocked:
          mergeType === 'intentional-family'
            ? 'router and child: architecture, not duplication, so nothing is proposed'
            : mergeType === 'shape-only'
              ? 'same section shape, different rules: these are separate skills, not copies'
            : 'same territory with high body overlap; bodies must be read end to end before this is applied'
      })
      if (groups.length > 120) break
    }
    if (groups.length > 120) break
  }

  const summary: Record<MergeType, number> = {
    'near-duplicate': 0,
    'partial-overlap': 0,
    'intentional-family': 0,
    'weak-evidence': 0,
      'cross-root-placement': 0,
      'shape-only': 0
  }
  for (const group of groups) summary[group.mergeType] += 1

  return { groups, summary, scanned: bodies.length, roots, ms: Date.now() - started }
}
