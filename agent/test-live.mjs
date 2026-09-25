#!/usr/bin/env node
// PORTED-FROM: agent/test-battery.mjs (same project) — live-deploy verification
// GOAL: Bryan-directed "do 1-3 end to end" — prove the DEPLOYED honest-associate worker
// serves the same verified behavior as local. Read-only checks against our own worker.
// Blindness channel: probe errors report UNKNOWN, never a confident verdict.
const BASE = process.argv[2] || 'https://honest-associate.neoaethel.workers.dev'
let pass = 0, fail = 0, unknown = 0
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++ }
const blind = (name, why) => { console.log(`UNKNOWN ${name} — probe failed: ${why}`); unknown++ }
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30e3) })
try {
  const b = await (await fetch(BASE + '/api/banner', { signal: AbortSignal.timeout(20e3) })).json()
  check('live banner', Number(b.opinionCount) > 0, `${b.opinionCount} opinions`)
} catch (e) { blind('live banner', e.message) }
try {
  const v = await (await post('/api/verify', { citation: 'United States v. Stephen Snyder' })).json()
  check('live real-case verify', v.verdict === 'FOUND_BY_NAME' && !!v.match?.excerpt, `${v.verdict} ${v.match?.caseName || '-'}`)
} catch (e) { blind('live real-case verify', e.message) }
try {
  const v = await (await post('/api/verify', { citation: 'Varghese v. China Southern Airlines Co., 925 F.3d 1339' })).json()
  check('live fake-case verify', v.verdict === 'NOT_IN_CORPUS', `${v.verdict} nearest=${(v.nearest || []).length}`)
} catch (e) { blind('live fake-case verify', e.message) }
try {
  const ui = await fetch(BASE + '/', { signal: AbortSignal.timeout(20e3) })
  const html = await ui.text()
  check('live UI', ui.status === 200 && html.includes('Honest Associate'), `status ${ui.status}`)
} catch (e) { blind('live UI', e.message) }
console.log(`\n${pass} passed, ${fail} failed, ${unknown} unknown`)
process.exit(fail ? 1 : unknown ? 3 : 0)
