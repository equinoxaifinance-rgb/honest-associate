#!/usr/bin/env node
// PORTED-FROM: ingest/ingest.mjs (politeFetch w/ auth+429 backoff, sanity client w/ timeout,
// loud per-doc logging — line-for-line; diff = targets a fixed id list and PATCHES fullText only).
// GOAL: Bryan live 2026-09-25 — "truncation doesnt become a factor." 29 opinions were stored at
// the old 150k ingest cap (dissents live past it). Re-fetch full text, cap 500k, patch in place.
// Blindness: every failure logs the id + reason; a final count states patched/failed explicitly.
import { createClient } from '@sanity/client'
import { readFileSync } from 'fs'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)))
const sanity = createClient({ projectId: '0b9qmvox', dataset: 'production', apiVersion: '2025-01-01', token: env.SANITY_WRITE_TOKEN, useCdn: false, timeout: 30000 })
const CL_TOKEN = env.COURTLISTENER_TOKEN
const CAP = 500000
let last = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function politeFetch(url) {
  for (let att = 0; att < 3; att++) {
    const gap = 1500 - (Date.now() - last)
    if (gap > 0) await sleep(gap)
    last = Date.now()
    const res = await fetch(url, { headers: { 'User-Agent': 'honest-associate-ingest/1.0 (equinoxlabsofficial@gmail.com)', Authorization: `Token ${CL_TOKEN}` }, signal: AbortSignal.timeout(60e3) })
    if (res.ok) return res.json()
    if (res.status === 429) { const ra = Number(res.headers.get('retry-after') || 0); console.log(`  429 wait=${Math.max(10, ra)}s`); await sleep(Math.max(10e3, ra * 1000)); continue }
    throw new Error(`HTTP ${res.status}`)
  }
  throw new Error('rate-limited x3')
}
const ids = (await sanity.fetch('*[_type == "opinion" && length(fullText) >= 150000].courtListenerId')).sort()
console.log(`re-ingesting ${ids.length} capped opinions at ${CAP}-char cap`)
let patched = 0, failed = 0
for (const id of ids) {
  try {
    const cluster = await politeFetch(`https://www.courtlistener.com/api/rest/v4/clusters/${id}/`)
    const opUrl = (cluster.sub_opinions || [])[0]
    if (!opUrl) throw new Error('no sub_opinions')
    const op = await politeFetch(opUrl)
    const text = op.plain_text || String(op.html_with_citations || '').replace(/<[^>]+>/g, ' ')
    if (!text || text.length < 150000) throw new Error(`refetched text shorter than stored (${text.length}) — not patching`)
    await sanity.patch(`opinion-cl-${id}`).set({ fullText: text.slice(0, CAP) }).commit()
    patched++
    console.log(`patched ${id}: ${text.length} chars${text.length > CAP ? ` (capped at ${CAP})` : ' (FULL)'}`)
  } catch (e) { failed++; console.log(`FAIL ${id}: ${String(e.message).slice(0, 80)}`) }
}
console.log(`DONE: ${patched} patched, ${failed} failed of ${ids.length}`)
