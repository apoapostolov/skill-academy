// Real on-disk test for the placement engine. Runs entirely in a scratch directory.
//   npx tsx scripts/test-placements.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MANIFEST, describe, place, unplace } from '../server/src/placement'

const root = path.join(os.tmpdir(), `skill-academy-place-${Date.now()}`)
const library = path.join(root, 'library')
const agentA = path.join(root, 'agent-a')
const agentB = path.join(root, 'agent-b')
const trash = path.join(root, 'trash')
const pkg = path.join(library, 'demo-skill')

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

fs.mkdirSync(pkg, { recursive: true })
fs.writeFileSync(path.join(pkg, 'SKILL.md'), '---\nname: demo-skill\ndescription: A package for the placement test.\n---\n\n# Demo\n')
fs.mkdirSync(agentA, { recursive: true })
fs.mkdirSync(agentB, { recursive: true })

console.log('link placement')
const linked = place(pkg, agentA)
check('placement succeeds', linked.ok, linked.reason)
check('mode is a link', linked.mode === 'junction' || linked.mode === 'symlink', String(linked.mode))
check('target reads through to the package', fs.existsSync(path.join(linked.target, 'SKILL.md')))
check('describe reports a link', describe(linked.target).link)
check('source untouched', fs.existsSync(path.join(pkg, 'SKILL.md')))

console.log('unplace a link')
const removedLink = unplace(linked.target, trash)
check('unplace succeeds', removedLink.ok, removedLink.reason)
check('link is gone', !fs.existsSync(linked.target))
check('source still there', fs.existsSync(path.join(pkg, 'SKILL.md')))

console.log('occupied target is never overwritten')
fs.mkdirSync(path.join(agentA, 'demo-skill'), { recursive: true })
fs.writeFileSync(path.join(agentA, 'demo-skill', 'SKILL.md'), 'someone else')
const blocked = place(pkg, agentA)
check('refuses an occupied target', !blocked.ok && blocked.reason === 'occupied', blocked.reason)
check('the other package is intact', fs.readFileSync(path.join(agentA, 'demo-skill', 'SKILL.md'), 'utf8') === 'someone else')

console.log('copy fallback')
const copied = place(pkg, agentB, { forceCopy: true })
check('copy succeeds', copied.ok, copied.reason)
check('mode is copy', copied.mode === 'copy', String(copied.mode))
check('manifest is written', fs.existsSync(path.join(copied.target, MANIFEST)))
check('copy is a real directory', fs.lstatSync(copied.target).isDirectory() && !fs.lstatSync(copied.target).isSymbolicLink())

console.log('unplace a copy')
const removedCopy = unplace(copied.target, trash)
check('copy unplace succeeds', removedCopy.ok, removedCopy.reason)
check('copy is gone from the agent root', !fs.existsSync(copied.target))
check('copy went to trash', Boolean(removedCopy.trashed && fs.existsSync(removedCopy.trashed)))
check('source survives', fs.existsSync(path.join(pkg, 'SKILL.md')))

console.log('a foreign directory is not ours to remove')
fs.mkdirSync(path.join(agentB, 'foreign'), { recursive: true })
fs.writeFileSync(path.join(agentB, 'foreign', 'SKILL.md'), 'not ours')
const foreign = unplace(path.join(agentB, 'foreign'), trash)
check('refuses a directory without a manifest', !foreign.ok && foreign.reason === 'not-ours', foreign.reason)
check('the foreign directory survives', fs.existsSync(path.join(agentB, 'foreign', 'SKILL.md')))

console.log('native package is not a placement')
const native = place(pkg, library)
check('native is reported as native', native.ok && native.mode === 'native', String(native.mode))

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
