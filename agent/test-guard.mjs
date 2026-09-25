// PORTED-FROM: agent/test-live.mjs probe shape — verify KV cache + daily budget organs live
// GOAL: Bryan-directed abuse-hardening — prove identical questions serve from cache ($0) and
// the global counter ticks. Blindness: probe errors report UNKNOWN, never a verdict.
const BASE = 'https://honest-associate.neoaethel.workers.dev'
const ask = (q) => fetch(BASE + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }), signal: AbortSignal.timeout(120e3) }).then(r => r.json())
try {
  const q = 'What did the Supreme Court decide about parental rights and school curriculum?'
  const t1 = Date.now(); const a1 = await ask(q); const d1 = Date.now() - t1
  console.log(`first ask: claims=${(a1.claims || []).length} served=${a1.served || 'fresh'} ${Math.round(d1 / 1000)}s`)
  const t2 = Date.now(); const a2 = await ask(q); const d2 = Date.now() - t2
  console.log(`second ask: claims=${(a2.claims || []).length} served=${a2.served || 'fresh'} ${Math.round(d2 / 1000)}s`)
  const pass = a2.served === 'cache' && d2 < 3000
  console.log(pass ? 'PASS cache organ live (second ask $0, instant)' : 'FAIL cache did not serve second ask')
  process.exit(pass ? 0 : 1)
} catch (e) { console.log('UNKNOWN — probe failed:', e.message); process.exit(3) }
