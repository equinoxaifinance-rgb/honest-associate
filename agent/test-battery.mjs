#!/usr/bin/env node
// PORTED-FROM: agent/test-ask.mjs (same project) — full local battery for the launch gate
// GOAL: Bryan-directed "do 1-3 end to end" — exercise every remaining route/edge of the
// honest-associate dev server at 127.0.0.1:8788. Reversible, local-only.
// Blindness channel: a probe that ERRORS reports UNKNOWN (could-not-tell), never PASS/FAIL —
// a checker that cannot confess blindness emits confident wrong verdicts (2026-09-07 x4).
const BASE = 'http://127.0.0.1:8788'
let pass = 0, fail = 0, unknown = 0
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++ }
const blind = (name, why) => { console.log(`UNKNOWN ${name} — probe itself failed: ${why} (verdict withheld)`); unknown++ }
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30e3) })

// 1. static UI served
try {
  const ui = await fetch(BASE + '/', { signal: AbortSignal.timeout(15e3) })
  const html = await ui.text()
  check('UI serves index.html', ui.status === 200 && html.includes('Honest Associate'), `status ${ui.status}, ${html.length} bytes`)
} catch (e) { blind('UI serves index.html', e.message) }

// 2. banner
try {
  const b = await (await fetch(BASE + '/api/banner', { signal: AbortSignal.timeout(15e3) })).json()
  check('banner has measured count', Number(b.opinionCount) > 0, `count ${b.opinionCount}`)
} catch (e) { blind('banner has measured count', e.message) }

// 3. FOUND_BY_CITATION — pull a real citation string from the public dataset, then verify it
try {
  const gq = encodeURIComponent('*[_type == "opinion" && count(citations) > 0][0]{ caseName, citations }')
  const doc = (await (await fetch(`https://0b9qmvox.api.sanity.io/v2025-01-01/data/query/production?query=${gq}`, { signal: AbortSignal.timeout(20e3) })).json()).result
  if (doc) {
    const v = await (await post('/api/verify', { citation: doc.citations[0] })).json()
    check('verify by citation string', v.verdict === 'FOUND_BY_CITATION' && v.match?.caseName === doc.caseName, `"${doc.citations[0]}" -> ${v.verdict} (${v.match?.caseName || '-'}) excerpt:${v.match?.excerpt ? 'yes' : 'EMPTY'}`)
  } else {
    check('verify by citation string', false, 'no doc with citations anywhere in corpus — ingest citation capture is broken')
  }
} catch (e) { blind('verify by citation string', e.message) }

// 4. garbage input stays honest
try {
  const g = await (await post('/api/verify', { citation: 'zxqv wibble nonexistent flurble' })).json()
  check('garbage -> NOT_IN_CORPUS, no fake nearest', g.verdict === 'NOT_IN_CORPUS' && (g.nearest || []).length === 0, JSON.stringify(g.nearest))
} catch (e) { blind('garbage stays honest', e.message) }

// 5. rate limiter bites past 20/10min
try {
  let got429 = 0
  for (let i = 0; i < 24; i++) {
    const r = await post('/api/verify', { citation: 'rate probe ' + i })
    if (r.status === 429) got429++
  }
  check('rate limiter returns 429', got429 > 0, `${got429} of 24 probes limited`)
} catch (e) { blind('rate limiter returns 429', e.message) }

console.log(`\n${pass} passed, ${fail} failed, ${unknown} unknown`)
process.exit(fail ? 1 : unknown ? 3 : 0)
