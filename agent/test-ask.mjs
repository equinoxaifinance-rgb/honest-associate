#!/usr/bin/env node
// PORTED-FROM: ingest/census.mjs fetch-and-report shape (same project) — local test driver
// GOAL: Bryan-directed "do 1-3 end to end" — verify the honest-associate /api/ask route at the
// data layer against the local wrangler dev server (127.0.0.1:8788). Reversible, read-only
// beyond a small authorized Anthropic call made by the worker itself.
const BASE = process.env.HA_BASE || 'http://127.0.0.1:8788'
const question = process.argv[2] || 'What has the Supreme Court said about universal injunctions?'
const res = await fetch(`${BASE}/api/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question }),
  signal: AbortSignal.timeout(120e3),
})
console.log('HTTP', res.status)
const d = await res.json()
if (d.error) console.log('ERROR:', d.error)
console.log('claims:', (d.claims || []).length, '| enforcementFired:', d.enforcementFired, '| evidence:', d.evidenceCount)
for (const c of d.claims || []) {
  console.log(` - ${c.grade} | ${c.caseName} | url:${c.absoluteUrl ? 'yes' : 'MISSING'}`)
  console.log(`   quote: ${String(c.quote || '').slice(0, 110)}`)
}
console.log('summary:', String(d.summary || '').slice(0, 260))
console.log('gap:', String(d.gap || '').slice(0, 260))
console.log('searches:', JSON.stringify(d.searchesTried))
