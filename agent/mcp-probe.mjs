#!/usr/bin/env node
// PORTED-FROM: agent/test-battery.mjs probe shape (same project)
// GOAL: Bryan-directed "do 1-3 end to end" — discover the Sanity Context MCP endpoint's tool
// surface so the worker can genuinely query it (challenge Path One). Read-only JSON-RPC probes.
// Blindness channel: any failed probe prints UNKNOWN with the reason; no verdict invented.
import { readFileSync } from 'fs'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)))
const URL_ = 'https://api.sanity.io/v1/context/organizations/oq358bde9/mcp/honest-associate-opinions'
const TOK = env.SANITY_CONTEXT_TOKEN
if (!TOK) { console.log('UNKNOWN — no SANITY_CONTEXT_TOKEN in .env'); process.exit(3) }
let sessionId = null
async function rpc(method, params, id) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOK}` }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id != null ? { id } : {}) }), signal: AbortSignal.timeout(30e3) })
  sessionId = res.headers.get('mcp-session-id') || sessionId
  const ct = res.headers.get('content-type') || ''
  const body = await res.text()
  if (!res.ok) { console.log(`UNKNOWN — HTTP ${res.status} on ${method}: ${body.slice(0, 200)}`); return null }
  if (id == null) return {}
  if (ct.includes('event-stream')) {
    const m = body.split(/\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
    for (const d of m) { try { const j = JSON.parse(d); if (j.id === id) return j } catch {} }
    console.log('UNKNOWN — no matching SSE data frame'); return null
  }
  try { return JSON.parse(body) } catch { console.log('UNKNOWN — unparseable body: ' + body.slice(0, 150)); return null }
}
const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'honest-associate-probe', version: '1.0' } }, 1)
if (!init) process.exit(3)
console.log('initialize ok — server:', JSON.stringify(init.result?.serverInfo || init.error))
await rpc('notifications/initialized', {})
const tools = await rpc('tools/list', {}, 2)
if (!tools) process.exit(3)
for (const t of tools.result?.tools || []) {
  console.log(`TOOL ${t.name}: ${String(t.description || '').slice(0, 120)}`)
  console.log('  input:', JSON.stringify(t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : t.inputSchema).slice(0, 200))
}
