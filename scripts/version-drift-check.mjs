// End-to-end proof for the three copy-drift banners against fixtures only.
//
// It boots an API and a Vite client on free ports, points both at a temporary library, then drives
// the real Chrome over CDP. Nothing here touches the live library or the live dev stack.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const repo = process.cwd()
const cdpBase = 'http://127.0.0.1:9333'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-academy-drift-'))
const library = path.join(tmp, 'library')
const data = path.join(tmp, 'data')
const logs = path.join(tmp, 'logs')
fs.mkdirSync(library, { recursive: true })
fs.mkdirSync(data, { recursive: true })
fs.mkdirSync(logs, { recursive: true })

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures.push(name)
}

function writeSkill(folder, name, version, rules) {
  const dir = path.join(library, folder)
  fs.mkdirSync(dir, { recursive: true })
  const body = [
    '---',
    `name: ${name}`,
    `description: Fixture copy ${folder} at version ${version} for the drift banners.`,
    'metadata:',
    '  hermes:',
    '    tags: ["family:drift-fixtures"]',
    `  version: ${version}`,
    '---',
    '',
    `# ${name}`,
    '',
    '## Rules',
    '',
    ...rules.map((rule) => `- ${rule}`),
    ''
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8')
}

const rule = (text) => `Keep this rule in the ${text} copy so a comparison has a real difference.`
writeSkill('zz-behind-old', 'zz-drift-behind', '1.0.0', [rule('older')])
writeSkill('zz-behind-new', 'zz-drift-behind', '2.0.0', [rule('newer')])
writeSkill('zz-ahead-one', 'zz-drift-ahead', '1.0.0', [rule('first older')])
writeSkill('zz-ahead-two', 'zz-drift-ahead', '1.5.0', [rule('second older')])
writeSkill('zz-ahead-three', 'zz-drift-ahead', '2.0.0', [rule('newest')])
writeSkill('zz-single-old', 'zz-drift-ahead-single', '1.0.0', [rule('single older')])
writeSkill('zz-single-new', 'zz-drift-ahead-single', '2.0.0', [rule('single newest')])

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function ready(url, label, logPath) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The process is still coming up.
    }
    await wait(250)
  }
  console.log(`${label} did not start. Log at ${logPath}`)
  process.exit(1)
}

const apiPort = await freePort()
let appPort = await freePort()
while (appPort === apiPort) appPort = await freePort()
const apiLog = path.join(logs, 'api.log')
const webLog = path.join(logs, 'web.log')
const apiFd = fs.openSync(apiLog, 'w')
const webFd = fs.openSync(webLog, 'w')
const common = {
  SKILL_ACADEMY_DATA: data,
  SKILL_ACADEMY_LIBRARY: library,
  SKILL_ACADEMY_ONLY_ROOTS: library,
  SKILL_ACADEMY_WATCH: '0',
  SKILL_ACADEMY_API_PORT: String(apiPort)
}
const api = spawn(process.execPath, [path.join(repo, 'node_modules/tsx/dist/cli.mjs'), 'server/src/index.ts'], {
  cwd: repo,
  env: { ...process.env, ...common },
  stdio: ['ignore', apiFd, apiFd]
})
const web = spawn(process.execPath, [path.join(repo, 'node_modules/vite/bin/vite.js')], {
  cwd: path.join(repo, 'web'),
  env: { ...process.env, ...common, SKILL_ACADEMY_APP_PORT: String(appPort) },
  stdio: ['ignore', webFd, webFd]
})

let cdpSocket
let tabId
async function cleanup() {
  if (cdpSocket && cdpSocket.readyState === WebSocket.OPEN) cdpSocket.close()
  if (tabId) {
    try {
      await fetch(`${cdpBase}/json/close/${tabId}`)
    } catch {
      // A tab that is already gone needs no closing.
    }
  }
  api.kill()
  web.kill()
  fs.closeSync(apiFd)
  fs.closeSync(webFd)
}
process.on('exit', () => {
  api.kill()
  web.kill()
})

try {
  await ready(`http://127.0.0.1:${apiPort}/api/skills?limit=1`, 'The fixture API', apiLog)
  const appUrl = `http://127.0.0.1:${appPort}/`
  await ready(appUrl, 'The fixture client', webLog)

  const tab = await (await fetch(`${cdpBase}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' })).json()
  tabId = tab.id
  cdpSocket = new WebSocket(tab.webSocketDebuggerUrl)
  let call = 0
  const waiting = new Map()
  const consoleErrors = []
  cdpSocket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg)
      waiting.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.text)
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
    }
  })
  await new Promise((resolve) => cdpSocket.addEventListener('open', resolve))
  const send = (method, params = {}) => {
    const id = ++call
    cdpSocket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve) => waiting.set(id, resolve))
  }
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return reply.result?.result?.value
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: appUrl })
  await wait(2600)

  async function select(name, version) {
    await evaluate(`(() => {
      const nav = [...document.querySelectorAll('.nav')].find((n) => n.textContent.trim().startsWith('All skills'))
      nav?.click()
      return !!nav
    })()`)
    await wait(600)
    const found = await evaluate(`(async () => {
      const list = await (await fetch('/api/skills?q=${name}&limit=30')).json()
      const row = (list.rows ?? []).find((candidate) => candidate.name === ${JSON.stringify(name)} && candidate.version === ${JSON.stringify(version)})
      if (!row) return null
      const input = document.querySelector('.search')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(name)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 1200))
      const node = document.querySelector('[data-skill-id="' + row.id + '"]')
      node?.click()
      return { id: row.id, clicked: !!node }
    })()`)
    await wait(1200)
    check(`selected ${name} v${version}`, Boolean(found?.clicked), JSON.stringify(found))
  }

  const readBanners = `(() => [...document.querySelectorAll('.detail .drift')].map((el) => ({
    kind: el.classList.contains('same-version') ? 'same' : el.classList.contains('ahead') ? 'ahead' : 'behind',
    text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    buttons: [...el.querySelectorAll('button')].map((b) => b.textContent.trim()),
    primary: el.querySelectorAll('.btn.primary').length
  })))()`

  // 1. Behind: the newer copy can be compared, opened and preselected for promotion.
  await select('zz-drift-behind', '1.0.0')
  const behind = (await evaluate(readBanners)).find((row) => row.kind === 'behind')
  check('the behind banner names both versions', Boolean(behind && /Behind.*v1\.0\.0.*v2\.0\.0/.test(behind.text)), JSON.stringify(behind))
  check('the behind banner offers Compare, Open copy and one primary', Boolean(behind && ['Compare', 'Open copy', 'Promote latest'].every((label) => behind.buttons.includes(label)) && behind.primary === 1), JSON.stringify(behind))

  await evaluate(`[...document.querySelectorAll('.detail .drift:not(.ahead):not(.same-version) button')].find((b) => b.textContent.trim() === 'Compare')?.click(); true`)
  await wait(1000)
  const compare = await evaluate(`(() => {
    const dlg = document.querySelector('[aria-label="Compare copies"]')
    return { open: !!dlg, sub: (dlg?.querySelector('.mergesub')?.textContent ?? '').slice(0, 140), files: dlg?.querySelectorAll('.mergediffrow').length ?? 0 }
  })()`)
  check('behind Compare opens a real two-copy diff', compare.open && /1\.0\.0/.test(compare.sub) && /2\.0\.0/.test(compare.sub) && compare.files > 0, JSON.stringify(compare))
  await evaluate(`document.querySelector('[aria-label="Compare copies"] .mergeheadactions .ghost:last-child')?.click(); true`)
  await wait(400)

  await evaluate(`[...document.querySelectorAll('.detail .drift:not(.ahead):not(.same-version) button')].find((b) => b.textContent.trim().startsWith('Promote latest'))?.click(); true`)
  await wait(1800)
  const promote = await evaluate(`(() => {
    const dlg = document.querySelector('.mergedialog')
    const winner = dlg?.querySelector('select')
    return { open: !!dlg, winner: winner?.value ?? null, enabled: dlg ? !dlg.querySelector('.mergeapply')?.disabled : false }
  })()`)
  check('Promote latest preselects the newer copy', promote.open && promote.winner.includes('zz-behind-new') && promote.enabled, JSON.stringify(promote))
  await evaluate(`[...document.querySelectorAll('.mergeheadactions .ghost')].find((b) => b.textContent.trim() === 'Close')?.click(); true`)
  await wait(400)

  // 2. Ahead with two older copies: information, no destructive primary, honest copy list.
  await select('zz-drift-ahead', '2.0.0')
  const aheadMany = (await evaluate(readBanners)).find((row) => row.kind === 'ahead')
  check('the ahead banner names the older copies', Boolean(aheadMany && /Ahead.*2 older copies/.test(aheadMany.text)), JSON.stringify(aheadMany))
  check('the ahead banner has no primary action', Boolean(aheadMany && aheadMany.primary === 0 && aheadMany.buttons.includes('Show copies')), JSON.stringify(aheadMany))
  await evaluate(`[...document.querySelectorAll('.detail .drift.ahead button')].find((b) => b.textContent.trim() === 'Show copies')?.click(); true`)
  await wait(400)
  const olderList = await evaluate(`(() => {
    const pop = document.querySelector('.copies-pop')
    return {
      head: (pop?.querySelector('.copies-pop-head span')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      rows: [...(pop?.querySelectorAll('.copies-row') ?? [])].map((row) => (row.textContent ?? '').replace(/\\s+/g, ' ').trim())
    }
  })()`)
  check('the copy list says older, not changed', /2 older copies/.test(olderList.head) && !/changed/.test(olderList.head), JSON.stringify(olderList))
  check('the copy list carries both older versions', olderList.rows.some((row) => row.includes('1.0.0')) && olderList.rows.some((row) => row.includes('1.5.0')), JSON.stringify(olderList))
  await evaluate(`document.querySelector('.copies-pop-head button')?.click(); true`)
  await wait(300)

  // 3. Ahead with one older copy: Compare and Open other, then Open other lands on the behind side.
  await select('zz-drift-ahead-single', '2.0.0')
  const aheadOne = (await evaluate(readBanners)).find((row) => row.kind === 'ahead')
  check('the single ahead banner names the older version', Boolean(aheadOne && /Ahead.*v1\.0\.0 exists in/.test(aheadOne.text)), JSON.stringify(aheadOne))
  check('the single ahead banner offers Compare and Open other only', Boolean(aheadOne && ['Compare', 'Open other'].every((label) => aheadOne.buttons.includes(label)) && aheadOne.buttons.length === 2), JSON.stringify(aheadOne))
  await evaluate(`[...document.querySelectorAll('.detail .drift.ahead button')].find((b) => b.textContent.trim() === 'Open other')?.click(); true`)
  await wait(1300)
  const landed = (await evaluate(readBanners)).map((row) => row.kind)
  check('Open other lands on the older copy', landed.includes('behind'), JSON.stringify(landed))

  check('no console errors while the banners render', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  check('the harness ran to completion', false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await cleanup()
}

console.log(failures.length ? `version drift checks FAILED: ${failures.join(', ')}` : 'version drift checks passed')
process.exit(failures.length ? 1 : 0)
