#!/usr/bin/env node
// PORTED-FROM: agent/mcp-probe.mjs (env loading + probe shape, same project)
// GOAL: Bryan-directed challenge compliance — the Sanity challenge's Path One OR-clause reads
// "point your agent at your full dataset through a Context MCP endpoint with embeddings enabled."
// Probe the dataset's embeddings-index state (list = read-only); create one only if ENABLE=1.
// Blindness channel: any HTTP/parse failure prints UNKNOWN + the raw status, never a verdict.
import { readFileSync } from 'fs'
const env = Object.fromEntries(readFileSync('C:/Users/Jesse/Desktop/honest-associate/.env', 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)))
const TOK = env.SANITY_WRITE_TOKEN
const PROJECT = '0b9qmvox', DATASET = 'production'
if (!TOK) { console.log('UNKNOWN — no SANITY_WRITE_TOKEN'); process.exit(3) }
const base = `https://${PROJECT}.api.sanity.io/vX/embeddings-index/${DATASET}`
const headers = { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' }

const list = await fetch(base, { headers, signal: AbortSignal.timeout(30e3) })
const listBody = await list.text()
console.log(`LIST ${list.status}: ${listBody.slice(0, 400)}`)
if (!list.ok) { console.log('UNKNOWN — list failed; embeddings-index API may need different version/plan'); process.exit(3) }

const existing = JSON.parse(listBody)
if (Array.isArray(existing) && existing.length) {
  console.log(`EMBEDDINGS ALREADY ENABLED — ${existing.length} index(es): ${existing.map((i) => i.indexName).join(', ')}`)
  process.exit(0)
}
if (!process.env.ENABLE) { console.log('No index exists. Re-run with ENABLE=1 to create one over opinion docs.'); process.exit(0) }

// Body shape per https://www.sanity.io/docs/embeddings-index-http-api-reference (fetched 2026-09-25):
// { indexName, filter, projection }. NOTE the same page: "This feature is available in the Growth
// plan" — on the free tier this create is expected to be rejected; we ship Dataset-mode GROQ
// retrieval (free) and disclose the semantic layers (KB entries / embeddings index) as the
// paid-tier upgrade path. The challenge's Path One OR-clause sanctions the dataset route.
const create = await fetch(base, {
  method: 'POST', headers,
  body: JSON.stringify({
    indexName: 'opinions-index',
    filter: `_type == "opinion"`,
    projection: `{ "text": caseName + ". " + summary }`,
  }),
  signal: AbortSignal.timeout(120e3),
})
const createBody = await create.text()
console.log(`CREATE ${create.status}: ${createBody.slice(0, 400)}`)
process.exit(create.ok ? 0 : 3)
