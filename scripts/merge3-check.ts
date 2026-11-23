#!/usr/bin/env node
/**
 * The three-way merge, checked on its own before sync relies on it.
 *
 * Every case names the base both machines started from, what each side did, and whether the result
 * is clean. A merge that silently drops a line is worse than a conflict, so the assertions are about
 * what survived, not only about the exit status.
 */
import { mergeText } from '../server/src/merge3'

const NL = '\n'

interface Case {
  name: string
  base: string
  local: string
  remote: string
  clean: boolean
  conflicts: number
  contains: string[]
  excludes?: string[]
}

const cases: Case[] = [
  {
    name: 'only this machine changed the file',
    base: `a${NL}b${NL}c${NL}`,
    local: `a${NL}B${NL}c${NL}`,
    remote: `a${NL}b${NL}c${NL}`,
    clean: true,
    conflicts: 0,
    contains: ['B'],
    excludes: ['<<<<<<<']
  },
  {
    name: 'only the shared copy changed the file',
    base: `a${NL}b${NL}c${NL}`,
    local: `a${NL}b${NL}c${NL}`,
    remote: `a${NL}b${NL}C${NL}`,
    clean: true,
    conflicts: 0,
    contains: ['C']
  },
  {
    name: 'two edits in different regions both land',
    base: `a${NL}b${NL}c${NL}d${NL}`,
    local: `A${NL}b${NL}c${NL}d${NL}`,
    remote: `a${NL}b${NL}c${NL}D${NL}`,
    clean: true,
    conflicts: 0,
    contains: ['A', 'b', 'c', 'D']
  },
  {
    name: 'the same edit on both sides is not a conflict',
    base: `a${NL}b${NL}c${NL}`,
    local: `a${NL}X${NL}c${NL}`,
    remote: `a${NL}X${NL}c${NL}`,
    clean: true,
    conflicts: 0,
    contains: ['X'],
    excludes: ['<<<<<<<']
  },
  {
    name: 'a rewrite of the same line on both sides conflicts',
    base: `a${NL}b${NL}c${NL}`,
    local: `a${NL}mine${NL}c${NL}`,
    remote: `a${NL}theirs${NL}c${NL}`,
    clean: false,
    conflicts: 1,
    contains: ['<<<<<<< this machine', 'mine', '=======', 'theirs', '>>>>>>> the shared copy']
  },
  {
    name: 'two additions at the same point are both kept',
    base: `a${NL}`,
    local: `a${NL}local rule${NL}`,
    remote: `a${NL}remote rule${NL}`,
    clean: true,
    conflicts: 0,
    contains: ['local rule', 'remote rule']
  },
  {
    name: 'a deletion here and an edit there keep the edit',
    base: `one${NL}two${NL}three${NL}`,
    local: `one${NL}three${NL}`,
    remote: `one${NL}two${NL}THREE${NL}`,
    clean: true,
    conflicts: 0,
    contains: ['one'],
    excludes: ['two']
  },
  {
    name: 'an empty base takes both sides as additions',
    base: '',
    local: `left${NL}`,
    remote: `right${NL}`,
    clean: true,
    conflicts: 0,
    contains: ['left', 'right']
  }
]

let failures = 0
for (const entry of cases) {
  const result = mergeText(entry.base, entry.local, entry.remote)
  const missing = entry.contains.filter((needle) => !result.text.includes(needle))
  const leaked = (entry.excludes ?? []).filter((needle) => result.text.includes(needle))
  const ok = result.clean === entry.clean && result.conflicts === entry.conflicts && !missing.length && !leaked.length
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${entry.name}`)
  if (!ok) {
    failures += 1
    console.log(`      clean=${result.clean} (want ${entry.clean}) conflicts=${result.conflicts} (want ${entry.conflicts})`)
    if (missing.length) console.log(`      missing: ${JSON.stringify(missing)}`)
    if (leaked.length) console.log(`      unexpected: ${JSON.stringify(leaked)}`)
    console.log(`      got: ${JSON.stringify(result.text)}`)
  }
}

console.log('')
if (failures) {
  console.log(`merge checks: ${failures} failed`)
  process.exit(1)
}
console.log(`merge checks: all passed`)
