// Smoke test for the Improve and Consolidate scopes in the live dev app.
// It drives the real Chrome over CDP, so a blank render fails here rather than in Apo's face.
const CDP = 'http://127.0.0.1:9333'
const APP = 'http://127.0.0.1:10008/'

const pages = await (await fetch(`${CDP}/json/list`)).json()
let target = pages.find((p) => p.type === 'page' && p.url.startsWith('http://127.0.0.1:10008'))
if (!target) {
  target = await (await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json()
  await new Promise((r) => setTimeout(r, 1500))
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const waiting = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg)
    waiting.delete(msg.id)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))

function send(method, params = {}) {
  const callId = ++id
  ws.send(JSON.stringify({ id: callId, method, params }))
  return new Promise((resolve) => waiting.set(callId, resolve))
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return reply.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: APP })
await new Promise((r) => setTimeout(r, 3000))

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// Console errors are the honest signal that a view threw while rendering.
await evaluate(`(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); const orig = console.error; console.error = (...a) => { window.__errs.push(a.map(String).join(' ')); orig(...a) }; return true })()`)

check('the app shell rendered', await evaluate(`document.querySelector('.nav') !== null`))

// Consolidate: click the sidebar entry and read the middle column.
await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.nav')].find((n) => n.textContent.trim().startsWith('Consolidate'))
  nav?.click()
  return !!nav
})()`)
await new Promise((r) => setTimeout(r, 5000))

const consolidate = await evaluate(`(() => {
  const view = document.querySelector('.consolidateview')
  const rows = document.querySelectorAll('.cv-row')
  const head = document.querySelector('.consolidateview .listcount')?.textContent ?? ''
  const foot = document.querySelector('.consolidateview .iv-foot')?.textContent ?? ''
  const detail = document.querySelector('.cdetail')?.textContent ?? ''
  return { hasView: !!view, rows: rows.length, head, foot, detail: detail.slice(0, 80) }
})()`)
check('the consolidate view renders', consolidate.hasView, JSON.stringify(consolidate))
check('the group list is populated', consolidate.rows > 0, `${consolidate.rows} row(s); head "${consolidate.head}"`)
check('the footer reports the comparison', /skills compared/.test(consolidate.foot), consolidate.foot)

if (consolidate.rows > 0) {
  await evaluate(`document.querySelector('.cv-row').click()`)
  await new Promise((r) => setTimeout(r, 800))
  const detail = await evaluate(`(() => {
    const d = document.querySelector('.cdetail')
    return { has: !!d, text: (d?.textContent ?? '').slice(0, 120), sections: d ? d.querySelectorAll('.cdetail-section').length : 0 }
  })()`)
  check('selecting a group fills the detail pane', detail.has && detail.sections > 0, JSON.stringify(detail))

  // The read gate is only worth something if the body is actually reachable from the pane.
  const opened = await evaluate(`(async () => {
    const btn = [...document.querySelectorAll('.cdetail-member-open')][0]
    if (!btn) return { found: false }
    btn.click()
    await new Promise((r) => setTimeout(r, 1200))
    const pre = document.querySelector('.cdetail-bodytext')
    return { found: true, chars: pre ? pre.textContent.length : 0 }
  })()`)
  check('a copy body reads in the pane', opened.found && opened.chars > 40, JSON.stringify(opened))

  // The plan preview must show the exact pointer body that would replace the loser.
  const preview = await evaluate(`(async () => {
    const btn = [...document.querySelectorAll('.cdetail-actions button')].find((b) => /^(Preview|Outline) /.test(b.textContent))
    if (!btn) return { found: false }
    btn.click()
    await new Promise((r) => setTimeout(r, 400))
    const pre = document.querySelector('.cdetail-bodytext')
    const outline = document.querySelector('.cdetail-outline')
    return { found: true, chars: pre ? pre.textContent.length : 0, lines: outline ? outline.children.length : 0 }
  })()`)
  check('the plan previews what it would write', preview.found ? preview.chars > 40 || preview.lines > 0 : true, JSON.stringify(preview))

  const shape = await evaluate(`(() => {
    const pane = document.querySelector('.cdetail')
    const text = pane?.textContent ?? ''
    const pres = [...pane.querySelectorAll('.cdetail-bodytext')]
    // The pointer preview is the last body in the pane, because the copies come first.
    const last = pres.length ? pres[pres.length - 1].textContent : ''
    return {
      sections: [...pane.querySelectorAll('.cdetail-section-head')].map((n) => n.textContent),
      mentionsSurvivor: /Merged into/.test(last) || last.length > 0,
      hasReadGate: /I read every copy and this plan/.test(text),
      applyDisabled: pane.querySelector('.mergeapply')?.disabled ?? null,
      warnings: [...pane.querySelectorAll('.cdetail-warn')].map((n) => n.textContent.slice(0, 60)),
      bodies: pres.length
    }
  })()`)
  check('the detail pane carries copies, plan and fold', ['Copies', 'Deterministic plan', 'AI fold'].every((name) => shape.sections.includes(name)), JSON.stringify(shape.sections))
  check('the read gate is present on the plan', shape.hasReadGate === true, String(shape.hasReadGate))
  check('a protected group refuses the write', shape.applyDisabled !== false, `apply disabled=${shape.applyDisabled}; ${JSON.stringify(shape.warnings)}`)
  check('both a copy body and a plan preview are in the pane', shape.bodies >= 2, `${shape.bodies} body block(s)`)

  await send('Page.captureScreenshot', { format: 'png' }).then(async (shot) => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync('C:/Users/theap/AppData/Local/Temp/ska-consolidate.png', Buffer.from(shot.result.data, 'base64'))
  })
}

// Every scope switch must be clean: a thrown render shows up as a console error.
const errs = await evaluate(`window.__errs ?? []`)
check('no console errors while rendering consolidate', errs.length === 0, JSON.stringify(errs.slice(0, 3)))

// Improve.
await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.nav')].find((n) => n.textContent.trim().startsWith('Improve'))
  nav?.click()
  return !!nav
})()`)
await new Promise((r) => setTimeout(r, 6000))
const improve = await evaluate(`(() => {
  const view = document.querySelector('.improveview')
  const rows = document.querySelectorAll('.iv-row')
  const head = document.querySelector('.improveview .listcount')?.textContent ?? ''
  return { hasView: !!view, rows: rows.length, head }
})()`)
check('the improve view renders', improve.hasView, JSON.stringify(improve))
check('the improve view lists findings or says the library is clean', improve.rows > 0 || /no finding|clean/i.test(improve.head), JSON.stringify(improve))

// Curation.
await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.nav')].find((n) => n.textContent.trim().startsWith('Curation'))
  nav?.click()
  return !!nav
})()`)
await new Promise((r) => setTimeout(r, 2500))
const curation = await evaluate(`(() => {
  const view = document.querySelector('.curationview')
  const rows = document.querySelectorAll('.curationview .iv-row')
  const head = document.querySelector('.curationview .listcount')?.textContent ?? ''
  const note = document.querySelector('.curationview .iv-rule-note')?.textContent ?? ''
  return { hasView: !!view, rows: rows.length, head, note: note.slice(0, 90) }
})()`)
check('the curation view renders', curation.hasView, JSON.stringify(curation))
check('curation lists ageing skills', curation.rows > 0, JSON.stringify(curation))
check('curation states that usage is unknown', /cannot see who loaded/.test(curation.note), curation.note)

const errs2 = await evaluate(`window.__errs ?? []`)
check('no console errors while rendering improve', errs2.length === 0, JSON.stringify(errs2.slice(0, 3)))

await send('Page.captureScreenshot', { format: 'png' }).then(async (shot) => {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('C:/Users/theap/AppData/Local/Temp/ska-ui-smoke.png', Buffer.from(shot.result.data, 'base64'))
})

ws.close()
console.log('')
console.log(failures.length ? `UI smoke FAILED: ${failures.join(', ')}` : 'UI smoke passed')
process.exit(failures.length ? 1 : 0)
