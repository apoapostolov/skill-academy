import { readFileSync } from 'node:fs'
import { parseEntry, summariseAudit } from '../server/src/skillssh'

let failed = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) {
    console.log(`PASS  ${label}${detail ? '  ' + detail : ''}`)
  } else {
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
    failed += 1
  }
}

const two = parseEntry('vercel-labs/skills')
check('a repository entry parses', two?.source === 'vercel-labs/skills' && two?.skill === null, JSON.stringify(two))

const three = parseEntry('vercel-labs/skills/find-skills')
check('a skill entry parses', three?.source === 'vercel-labs/skills' && three?.skill === 'find-skills', JSON.stringify(three))

const fromUrl = parseEntry('https://skills.sh/vercel-labs/skills/')
check('a skills.sh URL parses as its entry', fromUrl?.source === 'vercel-labs/skills', JSON.stringify(fromUrl))

check('junk is refused', parseEntry('not a repo') === null && parseEntry('one') === null && parseEntry('a/b/c/d') === null)

// The captured payload is the registry's own answer for one skill, kept so the parsing is testable
// without the network.
const payload = JSON.parse(readFileSync(new URL('../fixtures/audit/find-skills.json', import.meta.url), 'utf8'))
const verdict = summariseAudit(payload)
check('the registry verdict is the worst provider status', verdict?.verdict === 'warn', JSON.stringify(verdict?.verdict))
check('every provider is kept', verdict?.audits.length === 5, String(verdict?.audits.length))
check('the warning sorts first', verdict?.audits[0].status === 'warn', String(verdict?.audits[0].status))
check('a provider with no risk level stays null', (verdict?.audits.find((audit) => audit.provider === 'Socket')?.risk ?? null) === null)
check('an unknown payload is not invented', summariseAudit({ nope: true }) === null)

process.exit(failed ? 1 : 0)
