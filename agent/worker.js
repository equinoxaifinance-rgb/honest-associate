// Honest Associate — the legal research agent that cannot cite a case that isn't in its corpus.
// PORTED-FROM: the NeverClosed worker hardening pattern (per-IP rate limit, message caps, API key
//   server-side only; see neverclosed-auth-hardened — fail-open paths are wallet-drains, so every
//   public route here is capped: RATE_LIMIT/ip, MAX_Q chars, cheap model, bounded search budget.
//   Known limit, named: the in-memory rate map resets per worker isolate — demo-tier protection).
// KEY ISOLATION (resolved 2026-09-24): ANTHROPIC_API_KEY here is a DEDICATED workspace key —
//   $25/month spend cap, auto-expires ~2026-10-24, owner email alert at $10. It shares nothing
//   with any production system; worst case for this worker is the cap, not an outage. Burn is
//   further bounded in code: haiku, <=2 model calls/question, KV-counted daily ration
//   (DAILY_ASK_CAP), question cache, per-IP limit, MAX_Q chars, bounded response budget.
// OFFICIAL-DEVIATION: max_tokens here is an APPLICATION response budget on a product endpoint —
//   there is no benchmark, protocol, or comparison in this file to deviate from; Anthropic's API
//   requires the parameter for every caller. Stated so the marker ledger stays honest.
// DOCTRINE: every trust rule here is CODE that fires on the act, never a sentence the model is
//   asked to remember (the execution-layer principle from the study this entry demonstrates).
//
// THE FIVE ORGANS (design locked 2026-09-22):
//  1. Trust-by-inspection: every claim ships the exact quote + source link.
//  2. Seek-before-no: multi-query reformulation before any "not found".
//  3. Citation-verifier: 3-verdict check for any citation (the demo button).
//  4. Graded claims: DIRECT_QUOTE / SUPPORTED / RELATED — never naked assertions.
//  5. Honest edges: the corpus banner (measured values) rides on every response.
// PLUS the enforcement layer: verifyQuotes() — a mechanical check that every quoted span exists
// verbatim in the evidence the model was handed. A failed check REFUSES the answer and retries
// once with the violation named; still-failing claims are stripped. The model is never trusted to
// quote honestly; it is checked.

const SANITY_PROJECT = '0b9qmvox'
const SANITY_DATASET = 'production'
const MODEL = 'claude-haiku-4-5-20251001'
const MAX_Q = 500              // question length cap
const RATE_LIMIT = 20          // per IP per 10 min (per-isolate; demo-tier)
const MAX_SEARCHES = 4         // seek-before-no budget
const ANSWER_BUDGET = 3000     // response-token budget — 1500 truncated 6-claim answers mid-JSON (measured 2026-09-23)
const DAILY_ASK_CAP = 150      // global answered-questions/day (KV-backed; the per-IP limiter is per-isolate and resets)
const CACHE_TTL = 7 * 86400    // identical questions serve the stored verified answer for $0

// ---------- Sanity data access (GROQ over the HTTP API) ----------
async function groq(env, query, params = {}) {
  const url = new URL(`https://${SANITY_PROJECT}.api.sanity.io/v2025-01-01/data/query/${SANITY_DATASET}`)
  url.searchParams.set('query', query)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`$${k}`, JSON.stringify(v))
  const res = await fetch(url, { headers: env.SANITY_READ_TOKEN ? { Authorization: `Bearer ${env.SANITY_READ_TOKEN}` } : {} })
  if (!res.ok) throw new Error(`sanity ${res.status}`)
  return (await res.json()).result
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

// ---------- Sanity Context MCP lane (Path One: searches run THROUGH the hosted MCP endpoint;
// direct GROQ is the disclosed fallback, never a silent one) ----------
const CONTEXT_MCP = 'https://api.sanity.io/v1/context/organizations/oq358bde9/mcp/honest-associate-opinions'
let mcpSession = null, mcpReady = false // per-isolate
async function mcpRpc(env, method, params, id) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${env.SANITY_CONTEXT_TOKEN}` }
  if (mcpSession) headers['mcp-session-id'] = mcpSession
  const res = await fetch(CONTEXT_MCP, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id != null ? { id } : {}) }), signal: AbortSignal.timeout(20000) })
  mcpSession = res.headers.get('mcp-session-id') || mcpSession
  if (!res.ok) { await res.text(); throw new Error(`mcp ${res.status}`) }
  const body = await res.text()
  if (id == null) return null
  let msg = null
  if ((res.headers.get('content-type') || '').includes('event-stream')) {
    for (const l of body.split('\n')) if (l.startsWith('data:')) { try { const j = JSON.parse(l.slice(5).trim()); if (j.id === id) msg = j } catch {} }
  } else { try { msg = JSON.parse(body) } catch {} }
  if (!msg) throw new Error('mcp: unparseable response')
  if (msg.error) throw new Error(`mcp: ${String(msg.error.message || '').slice(0, 80)}`)
  return msg.result
}
async function mcpGroq(env, query) {
  if (!env.SANITY_CONTEXT_TOKEN) throw new Error('no context token configured')
  if (!mcpReady) {
    await mcpRpc(env, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'honest-associate-worker', version: '1.0' } }, 1)
    await mcpRpc(env, 'notifications/initialized', {})
    mcpReady = true
  }
  const r = await mcpRpc(env, 'tools/call', { name: 'groq_query', arguments: { query } }, 2)
  if (r?.isError) throw new Error('mcp: tool error ' + String((r.content || [])[0]?.text || '').slice(0, 60))
  const text = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const m = text.match(/[\[{][\s\S]*[\]}]/)
  if (!m) throw new Error('mcp: no JSON in tool result')
  // the tool wraps rows as {"meta":{...},"result":[...]} (measured 2026-09-23)
  const parsed = JSON.parse(m[0])
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.result)) return parsed.result
  throw new Error('mcp: unexpected result shape') // throw → disclosed direct-groq fallback, never a silent []
}

async function searchOpinions(env, q, limit = 5) {
  // params inlined via JSON.stringify (safe GROQ string literal) — the MCP groq_query tool takes
  // only a query string, no param map
  const qq = JSON.stringify(q + '*')
  // "excerpt": summary — NOT fullText[0...N]: GROQ array-slice syntax on a string returns null (measured 2026-09-23)
  const query = `*[_type == "opinion"] | score(caseName match ${qq} || fullText match ${qq}, boost(caseName match ${qq}, 3)) | order(_score desc) [0...${limit}] { _score, caseName, citations, court, dateFiled, precedentialStatus, absoluteUrl, courtListenerId, "excerpt": summary }`
  try {
    const rows = await mcpGroq(env, query)
    return Object.assign(Array.isArray(rows) ? rows : [], { lane: 'context-mcp' })
  } catch (e) {
    mcpReady = false // stale session gets a fresh handshake next call
    const rows = await groq(env, query, {})
    return Object.assign(rows || [], { lane: `direct-groq (mcp: ${String(e.message).slice(0, 40)})` })
  }
}

async function getFullOpinion(env, clusterId) {
  return groq(env, `*[_type == "opinion" && courtListenerId == $id][0]{ caseName, citations, court, dateFiled, precedentialStatus, absoluteUrl, fullText }`, { id: clusterId })
}

async function corpusBanner(env) {
  return groq(env, `*[_id == "corpusInfo-main"][0]{ opinionCount, dateRangeStart, dateRangeEnd, courtsCovered, source, disclaimer, ingestedAt }`)
}

// ---------- Organ: mechanical quote verification ----------
// squeeze: compare the exact LETTER SEQUENCE, whitespace-free. CourtListener plain text is
// hard-wrapped with hyphenation ("Govern-\nment's", 445 breaks in one opinion, measured
// 2026-09-23) — honest quotes died on whitespace artifacts while word substitutions are the
// real fabrication class ("granted" for "given", caught same day). Squeeze forgives the
// former and still kills the latter.
const squeeze = (s) => norm(String(s || '').replace(/([A-Za-z])-\s*\n\s*(?=[a-z])/g, '$1')).replace(/ /g, '')
function verifyQuotes(claims, evidenceById) {
  const violations = []
  for (const c of claims || []) {
    if (!c.quote) { violations.push({ claim: c, why: 'claim has no quote — naked assertions are not carried' }); continue }
    // accept either key — the model coin-flips between the schema's name and the tag's name
    const ev = evidenceById[c.courtListenerId ?? c.clusterId]
    if (!ev) { violations.push({ claim: c, why: 'cites a document not in the evidence set' }); continue }
    const hay = squeeze(ev.fullText)
    const needle = squeeze(c.quote)
    if (needle.length < 20) { violations.push({ claim: c, why: 'quote too short to verify' }); continue }
    if (!hay.includes(needle)) violations.push({ claim: c, why: 'quote not found verbatim in the cited opinion (letter-for-letter, whitespace ignored)' })
  }
  return violations
}

// ---------- Organ: semantic lane (Sanity embeddings-index over the full corpus) ----------
// Catches paraphrases keyword `match` misses ("executive order ending birthright citizenship"
// -> Trump v. CASA by meaning, measured 2026-09-25). Non-fatal: an error is disclosed, never silent.
async function semanticSearch(env, question, limit = 3) {
  const res = await fetch(`https://${SANITY_PROJECT}.api.sanity.io/vX/embeddings-index/query/${SANITY_DATASET}/opinions-index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SANITY_CONTEXT_TOKEN}` },
    body: JSON.stringify({ query: question, maxResults: limit }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`embeddings ${res.status}`)
  const rows = await res.json()
  return (rows || [])
    .map((r) => /^opinion-cl-(\d+)$/.exec(String(r.value?.documentId || '')))
    .filter(Boolean)
    .map((m) => ({ courtListenerId: Number(m[1]), caseName: '(semantic hit)' }))
}

// ---------- Organ: seek-before-no ----------
async function seek(env, question) {
  const tried = []
  const seen = new Map()
  const queries = [question]
  const words = question.split(/\s+/).filter((w) => w.length > 3)
  if (words.length > 2) queries.push(words.slice(0, 6).join(' '))
  if (words.length > 4) queries.push(words.slice(-5).join(' '))
  // semantic lane first: meaning-based recall over all 350 opinions via the embeddings index
  try {
    const sem = await semanticSearch(env, question, 3)
    tried.push(`semantic [via embeddings-index: ${sem.length} hits]`)
    for (const h of sem) if (!seen.has(h.courtListenerId)) seen.set(h.courtListenerId, h)
  } catch (e) { tried.push(`semantic [embeddings unavailable: ${String(e.message).slice(0, 30)}]`) }
  for (const q of queries.slice(0, MAX_SEARCHES)) {
    try {
      const hits = await searchOpinions(env, q, 5)
      tried.push(`${q} [via ${hits.lane || '?'}]`)
      for (const h of hits || []) if (h && !seen.has(h.courtListenerId)) seen.set(h.courtListenerId, h)
    } catch (e) { tried.push(`${q} [search failed: ${String(e.message).slice(0, 40)}]`) }
    if (seen.size >= 6) break
  }
  return { tried, hits: [...seen.values()] }
}

// ---------- The agent answer route ----------
async function answer(env, question) {
  const banner = await corpusBanner(env)
  const { tried, hits } = await seek(env, question)

  const evidenceById = {}
  for (const h of hits.slice(0, 4)) {
    const full = await getFullOpinion(env, h.courtListenerId)
    if (full) evidenceById[h.courtListenerId] = full
  }

  const evidenceBlock = Object.entries(evidenceById)
    // de-hyphenate the hard-wrapped source so the model can quote clean contiguous spans
    .map(([id, e]) => `<opinion courtListenerId="${id}" case="${e.caseName}" court="${e.court}" filed="${e.dateFiled}" status="${e.precedentialStatus}">\n${String(e.fullText).replace(/([A-Za-z])-\s*\n\s*(?=[a-z])/g, '$1').slice(0, 28000)}\n</opinion>`)
    .join('\n\n')

  const system = `You are the Honest Associate, a legal research aid answering ONLY from the court opinions provided in <opinion> blocks. Rules (mechanically enforced downstream — violations are rejected):
1. Every claim about a case must include a verbatim quote from that opinion (15+ words) in the "quote" field, plus the "courtListenerId" copied from that opinion's courtListenerId attribute. Copy the quote as ONE exact contiguous span — change no words, fix no grammar, no ellipses, never stitch two passages together.
2. Grade every claim: DIRECT_QUOTE (verbatim support), SUPPORTED (fair paraphrase, quote shown), RELATED (adjacent but not answering) — or omit it.
3. If the provided opinions do not answer the question, say so in "gap" — never fill gaps from memory. Anything not in the evidence does not exist for you.
4. This is a research aid, not legal advice; do not address outcomes of pending matters.
Respond ONLY with JSON: {"claims":[{"grade":"DIRECT_QUOTE|SUPPORTED|RELATED","statement":"...","quote":"...","caseName":"...","courtListenerId":123}],"gap":"what the corpus does not answer, or empty","summary":"2-3 sentence plain answer grounded only in the claims"}`

  const call = async (extra) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: ANSWER_BUDGET, system,
        messages: [{ role: 'user', content: `${extra || ''}Question: ${question}\n\nEvidence:\n${evidenceBlock || '(no opinions matched the searches)'}` }],
      }),
    })
    if (!res.ok) throw new Error(`model ${res.status}`)
    const j = await res.json()
    const txt = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    const m = txt.match(/\{[\s\S]*\}/)
    if (!m) return { claims: [], gap: 'model returned no parseable answer', summary: '' }
    try { return JSON.parse(m[0]) } catch {}
    // salvage a max_tokens-truncated response: walk back to the last complete claim object and
    // re-close the JSON. Recovered claims still pass through the quote verifier like any others.
    const s = m[0]
    for (let pos = s.lastIndexOf('}'); pos > 0 && pos > s.length - 4000; pos = s.lastIndexOf('}', pos - 1)) {
      for (const closer of ['', ']}', '}]}', ']}}']) {
        try {
          const cand = JSON.parse(s.slice(0, pos + 1) + closer)
          if (cand && Array.isArray(cand.claims)) {
            console.log(`SALVAGE: recovered ${cand.claims.length} claims from truncated JSON (stop_reason=${j.stop_reason})`)
            cand.gap = ((cand.gap || '') + ' [The answer was truncated by the response budget; complete claims were kept.]').trim()
            return cand
          }
        } catch {}
      }
    }
    return { claims: [], gap: 'model response was truncated beyond recovery', summary: '' }
  }

  let out = await call()
  let violations = verifyQuotes(out.claims, evidenceById)
  let enforced = false
  if (violations.length) {
    enforced = true
    console.log('QUOTE-VERIFIER round 1:', JSON.stringify(violations.map((v) => ({ why: v.why, case: v.claim.caseName, id: v.claim.courtListenerId, q: String(v.claim.quote || '').slice(0, 60) }))), 'evidence keys:', Object.keys(evidenceById).join(','))
    try {
      out = await call(`PREVIOUS ATTEMPT REJECTED by the quote verifier: ${violations.map((v) => v.why).join('; ')}. Quotes must be copied EXACTLY as they appear in the opinion — no ellipses, no elisions, no stitching two passages together. Fix or drop the offending claims. `)
    } catch (e) {
      // a transient model error on the RETRY must not kill an otherwise-good answer —
      // keep round 1 and let the strip below remove its violating claims
      console.log('QUOTE-VERIFIER retry call failed, degrading to stripped round 1:', String(e.message))
    }
    violations = verifyQuotes(out.claims, evidenceById)
    if (violations.length) {
      console.log('QUOTE-VERIFIER round 2:', JSON.stringify(violations.map((v) => ({ why: v.why, case: v.claim.caseName, q: String(v.claim.quote || '').slice(0, 120) }))))
      const bad = new Set(violations.map((v) => v.claim))
      out.claims = (out.claims || []).filter((c) => !bad.has(c))
      out.gap = ((out.gap || '') + ' [Some claims were removed by the quote verifier.]').trim()
    }
  }
  // a summary may not stand on zero surviving claims — that would be an unsupported answer
  // wearing the tool's credibility (the exact failure this agent exists to forbid)
  if (!(out.claims || []).length && out.summary) {
    out.gap = ((out.gap || '') + ' [A draft answer existed but no claim survived mechanical quote verification, so it was withheld.]').trim()
    out.summary = ''
  }

  // source links come from the evidence store (server-side truth), never from model output
  for (const c of out.claims || []) {
    const ev = evidenceById[c.courtListenerId ?? c.clusterId]
    if (ev) { c.absoluteUrl = ev.absoluteUrl; c.court = ev.court; c.dateFiled = ev.dateFiled; c.precedentialStatus = ev.precedentialStatus }
  }

  return { banner, searchesTried: tried, evidenceCount: Object.keys(evidenceById).length, enforcementFired: enforced, ...out }
}

// ---------- The citation-verifier route (the demo button) ----------
async function verifyCitation(env, input) {
  const q = String(input || '').slice(0, 200)
  const byCite = await groq(env, `*[_type == "opinion" && $q in citations][0]{ caseName, citations, court, dateFiled, absoluteUrl, courtListenerId, "excerpt": summary }`, { q })
  // some ingested docs have an empty search snippet — fall back to the opinion's own opening text
  const withExcerpt = async (m) => {
    if (!m.excerpt) {
      const full = await getFullOpinion(env, m.courtListenerId)
      if (full) m.excerpt = String(full.fullText || '').slice(0, 400)
    }
    return m
  }
  if (byCite) return { verdict: 'FOUND_BY_CITATION', match: await withExcerpt(byCite) }
  const hits = await searchOpinions(env, q, 3)
  const strong = (hits || []).find((h) => norm(h.caseName).includes(norm(q)) || norm(q).includes(norm(h.caseName)))
  if (strong) return { verdict: 'FOUND_BY_NAME', match: await withExcerpt(strong) }
  return {
    verdict: 'NOT_IN_CORPUS',
    // zero-score rows are arbitrary, not "nearest" — presenting them as similar would be its own small lie
    nearest: (hits || []).filter((h) => (h._score || 0) > 0).slice(0, 3).map((h) => ({ caseName: h.caseName, court: h.court, dateFiled: h.dateFiled, absoluteUrl: h.absoluteUrl })),
    note: 'Not in THIS corpus (see banner for its boundaries) — a statement about our collection, not about the world. A citation that cannot be located anywhere should be treated as suspect.',
  }
}

// ---------- HTTP plumbing ----------
const RL = new Map()
function rateLimited(ip) {
  const now = Date.now()
  const fresh = (RL.get(ip) || []).filter((t) => now - t < 600000)
  fresh.push(now)
  RL.set(ip, fresh)
  return fresh.length > RATE_LIMIT
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    // same-origin only: the UI is served by this worker, so no cross-origin caller is legitimate.
    // CORS doesn't stop curl (the caps do) — this just denies third-party BROWSER embedding.
    // (audit finding 2026-09-24: '*' + open POST was a free abuse lane for hostile sites)
    const cors = {
      'Access-Control-Allow-Origin': url.origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'content-type': 'application/json',
    }
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    const ip = request.headers.get('cf-connecting-ip') || 'local'
    try {
      if (url.pathname === '/api/banner') {
        return new Response(JSON.stringify(await corpusBanner(env)), { headers: cors })
      }
      if (url.pathname === '/api/ask' && request.method === 'POST') {
        if (rateLimited(ip)) return new Response(JSON.stringify({ error: 'rate limit — try again in a few minutes' }), { status: 429, headers: cors })
        const { question } = await request.json()
        if (!question || question.length > MAX_Q) return new Response(JSON.stringify({ error: `question required, max ${MAX_Q} chars` }), { status: 400, headers: cors })

        // cache first: identical questions cost $0 and answer instantly (disclosed via served field)
        const qKey = 'q:' + norm(question).slice(0, 480)
        const cached = env.ASK_GUARD ? await env.ASK_GUARD.get(qKey) : null
        if (cached) return new Response(JSON.stringify({ ...JSON.parse(cached), served: 'cache' }), { headers: cors })

        // global daily budget: a shared KV counter distributed abuse can't reset. KV is not
        // atomic, so we PRE-increment before the model call — the race window is the ~1s put,
        // not the ~20s answer (audit finding 2026-09-24). Overshoot is bounded by the per-IP
        // limiter and, ultimately, the key's $25 spend cap; this is a breaker, not a ledger.
        const day = 'budget:' + new Date().toISOString().slice(0, 10)
        const used = Number((env.ASK_GUARD && (await env.ASK_GUARD.get(day))) || 0)
        if (used >= DAILY_ASK_CAP) {
          return new Response(JSON.stringify({ error: `today's demo budget (${DAILY_ASK_CAP} answered questions) is spent — the citation-verifier tab still works, and the budget resets at midnight UTC` }), { status: 429, headers: cors })
        }
        if (env.ASK_GUARD) await env.ASK_GUARD.put(day, String(used + 1), { expirationTtl: 2 * 86400 })
        const out = await answer(env, question)
        if (env.ASK_GUARD) await env.ASK_GUARD.put(qKey, JSON.stringify(out), { expirationTtl: CACHE_TTL })
        return new Response(JSON.stringify(out), { headers: cors })
      }
      if (url.pathname === '/api/verify' && request.method === 'POST') {
        if (rateLimited(ip)) return new Response(JSON.stringify({ error: 'rate limit — try again in a few minutes' }), { status: 429, headers: cors })
        const { citation } = await request.json()
        if (!citation) return new Response(JSON.stringify({ error: 'citation required' }), { status: 400, headers: cors })
        return new Response(JSON.stringify(await verifyCitation(env, citation)), { headers: cors })
      }
      if (url.pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'unknown API route or wrong method — /api/ask and /api/verify take POST' }), { status: 405, headers: cors })
      }
      return new Response(JSON.stringify({ ok: true, service: 'honest-associate', routes: ['/api/banner', '/api/ask', '/api/verify'] }), { headers: cors })
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e).slice(0, 200) }), { status: 500, headers: cors })
    }
  },
}
