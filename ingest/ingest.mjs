#!/usr/bin/env node
// CourtListener -> Sanity ingest for the Honest Associate corpus.
// PORTED-FROM: the frontier-tools polite-fetch pattern (single queue, >=1.5s gap, res.ok checked,
//   429 Retry-After honored with backoff, LOUD failure - the 2026-09-20 silent-429 poisoning taught
//   this shape) + idempotent upserts (_id = deterministic from source id, skip-if-exists resume).
// SCOPE: published Fourth Circuit + SCOTUS opinions, filed_after cutoff, capped count - the corpus
//   banner states exactly what got ingested; honest edges are a feature.
// Usage: SANITY_WRITE_TOKEN=<token> node ingest.mjs [--court ca4|scotus] [--max 250] [--after 2023-01-01]
import { createClient } from '@sanity/client'

const TOKEN = process.env.SANITY_WRITE_TOKEN
if (!TOKEN) { console.error('SANITY_WRITE_TOKEN missing - mint an Editor token at sanity.io/manage (never commit it)'); process.exit(1) }

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d }
const COURT = arg('--court', 'ca4')
const MAX = Number(arg('--max', '250'))
const AFTER = arg('--after', '2023-01-01')

// timeout:30s — a naked Sanity call hung the whole loop silently for 20 min on 2026-09-22 (log
// frozen at 90, data layer at 94, no error). Every network client gets a timeout. No exceptions.
const sanity = createClient({ projectId: '0b9qmvox', dataset: 'production', apiVersion: '2025-01-01', token: TOKEN, useCdn: false, timeout: 30000 })

// GAP env-tunable: authenticated tier runs thousands/hr (limits doubled through Oct 1 per their
// banner); 1500ms default stays for anonymous courtesy, 600ms sanctioned when authenticated.
const GAP = Number(process.env.INGEST_GAP) || 1500

// polite fetch: single lane, 1.5s gap, loud on failure. COURTLISTENER_TOKEN authenticates the
// full-text endpoints (the anonymous tier 401s on /opinions/{id}/ — measured 2026-09-22).
const CL_TOKEN = process.env.COURTLISTENER_TOKEN || ''
let last = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function politeFetch(url) {
  for (let att = 0; att < 3; att++) {
    const gap = GAP - (Date.now() - last)
    if (gap > 0) await sleep(gap)
    last = Date.now()
    const headers = { 'User-Agent': 'honest-associate-ingest/1.0 (equinoxlabsofficial@gmail.com)' }
    if (CL_TOKEN) headers['Authorization'] = `Token ${CL_TOKEN}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60e3) })
    if (res.ok) return res.json()
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') || 0)
      const wait = Math.max(10e3, ra * 1000) * (att + 1)
      // loud + beat-aware: a logged wait is not a hang — the watchdog only kills SILENT stalls.
      // (2026-09-23: watchdog killed a run mid-backoff because this branch slept unlogged.)
      console.log(`  429 backoff att${att + 1}/3 wait=${Math.round(wait / 1000)}s`)
      // sleep in 60s slices, beating each slice — CourtListener sent Retry-After 7200s on
      // 2026-09-23 and a single beat cannot survive a 2-hour logged wait.
      for (let s = wait; s > 0; s -= 60e3) { lastBeat = Date.now(); await sleep(Math.min(60e3, s)) }
      continue
    }
    throw new Error(`HTTP ${res.status} on ${url}`)
  }
  throw new Error(`rate-limited after 3 attempts: ${url}`)
}

console.log(`INGEST court=${COURT} max=${MAX} after=${AFTER} gap=${GAP}ms`)

// WATCHDOG: the 2026-09-22 overnight run froze silently for 10+ minutes past every per-call
// timeout — cause unlocated because nothing logged per-doc. Now: every doc logs BEFORE processing
// (a stall names its own hang site), and if no doc completes for 3 minutes the process exits loud.
let lastBeat = Date.now()
const watchdog = setInterval(() => {
  if (Date.now() - lastBeat > 180000) {
    console.log(`WATCHDOG: no document completed in 3min — exiting loud (last beat ${new Date(lastBeat).toISOString()})`)
    process.exit(2)
  }
}, 30000)
watchdog.unref?.()
let url = `https://www.courtlistener.com/api/rest/v4/search/?type=o&court=${COURT}&filed_after=${AFTER}&stat_Published=on&order_by=dateFiled%20desc`
let done = 0, skipped = 0, failed = 0, failStreak = 0

// BREAKER (ported after the miss: frontier-tools' 10-straight-failures rule — a dead auth tier
// burned 494 fruitless fetches on 2026-09-22 because this rig lacked it. Never again.)
while (url && done + skipped + failed < MAX * 2 && failStreak < 10) {
  const page = await politeFetch(url)
  for (const r of page.results || []) {
    if (done + skipped >= MAX || failStreak >= 10) break
    const clusterId = r.cluster_id
    const _id = `opinion-cl-${clusterId}`
    console.log(`> ${clusterId} ${String(r.caseName).slice(0, 60)}`)
    try {
      const exists = await sanity.fetch('*[_id == $id][0]._id', { id: _id })
      if (exists) { skipped++; lastBeat = Date.now(); continue }
      // the search result carries opinions[] with ids; fetch full text for the lead opinion
      const opId = r.opinions?.[0]?.id
      let fullText = '', summary = r.snippet || ''
      if (opId) {
        const op = await politeFetch(`https://www.courtlistener.com/api/rest/v4/opinions/${opId}/`)
        fullText = op.plain_text || op.html_with_citations?.replace(/<[^>]+>/g, ' ') || ''
      }
      if (!fullText || fullText.length < 500) { failed++; failStreak++; console.log(`  SKIP-THIN ${r.caseName} (${fullText.length} chars)`); continue }
      await sanity.createOrReplace({
        _id,
        _type: 'opinion',
        caseName: r.caseName,
        citations: (r.citation || []).filter(Boolean),
        court: COURT,
        dateFiled: r.dateFiled,
        docketNumber: r.docketNumber || '',
        precedentialStatus: r.status || 'Published',
        judges: r.judge || '',
        summary: String(summary).replace(/<[^>]+>/g, ' ').slice(0, 2000),
        fullText: fullText.slice(0, 150000),
        courtListenerId: clusterId,
        absoluteUrl: `https://www.courtlistener.com${r.absolute_url}`,
      })
      done++
      failStreak = 0
      lastBeat = Date.now()
      if (done % 10 === 0) console.log(`  ${done} ingested · ${skipped} skipped · ${failed} thin/failed`)
    } catch (e) {
      failed++
      failStreak++
      console.log(`  FAIL ${r.caseName}: ${String(e.message).slice(0, 100)}`)
    }
  }
  url = page.next
}

console.log(`\nDONE court=${COURT}: ${done} ingested · ${skipped} already-present · ${failed} thin/failed`)
console.log('Now update the corpusInfo document (npm run corpus-banner or via Studio) so the edges stay honest.')
