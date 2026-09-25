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
// COST BOUND (audit 2026-09-25: 360k chars × 150/day worst-cased ~$31/day vs the $25/MONTH key
// cap — the bound must hold on the worst day): 240k chars ≈ 60k tokens ≈ 7¢/ask incl. retry;
// 80/day × 7¢ ≈ $5.6 worst-day, so even sustained abuse cannot kill the key inside judging week.
const DAILY_ASK_CAP = 80       // global answered-questions/day (KV-backed; the per-IP limiter is per-isolate and resets)
const CACHE_TTL = 7 * 86400    // verified answers serve from cache for $0
const CACHE_TTL_DEGRADED = 6 * 3600 // zero-claim/degraded answers expire fast — outages must not be immortalized
const EVIDENCE_DOCS = 4        // opinions read per question
// Dynamic evidence budget (2026-09-25, Bryan: "truncation doesnt become a factor"): short opinions
// go in FULL; the shared budget's leftovers flow to the giants; cut giants get head+tail windows.
const TOTAL_EVIDENCE_CHARS = 240000
const MIN_SLICE = 20000              // no doc gets starved below this

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
// per-isolate session; init deduplicated through ONE promise so concurrent requests can't
// interleave the handshake (audit: two racers overwrote each other's session ids)
let mcpSession = null, mcpInit = null
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
  if (!mcpInit) {
    mcpInit = (async () => {
      await mcpRpc(env, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'honest-associate-worker', version: '1.0' } }, 1)
      await mcpRpc(env, 'notifications/initialized', {})
    })()
    mcpInit.catch(() => { mcpInit = null; mcpSession = null }) // failed handshake resets cleanly
  }
  await mcpInit
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
    // full reset: a DEAD session id must not ride into the next handshake (audit: wedged-lane loop)
    mcpInit = null; mcpSession = null
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
// verifyMap[id] = { sqShown, sqFull } — squeezed ONCE per doc (memoized; recomputing per claim
// burned CPU on 500k-char strings). DUAL CHECK (audit catch 2026-09-25): a quote must exist in
// the text the model was actually SHOWN (else it recalled it from weights — e.g. the omitted
// middle of a famous case) AND in the full stored opinion (else it stitched across the omission
// seam). Shown-only or full-only both fail; the core guarantee holds on both edges.
function verifyQuotes(claims, verifyMap) {
  const violations = []
  for (const c of claims || []) {
    if (!c.quote) { violations.push({ claim: c, why: 'claim has no quote — naked assertions are not carried' }); continue }
    const ev = verifyMap[c.courtListenerId]
    if (!ev) { violations.push({ claim: c, why: 'cites a document not in the evidence set' }); continue }
    const needle = squeeze(c.quote)
    // 60 squeezed chars ≈ the prompt's own 15-word floor — 20 let boilerplate spans like
    // "the district court granted" pass as "verification" (audit S6)
    if (needle.length < 60) { violations.push({ claim: c, why: 'quote too short to verify (need 15+ words)' }); continue }
    if (!ev.sqShown.includes(needle)) { violations.push({ claim: c, why: 'quote not found in the evidence text you were shown' }); continue }
    if (!ev.sqFull.includes(needle)) violations.push({ claim: c, why: 'quote does not appear contiguously in the opinion (do not quote across the omission marker)' })
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
    .map((m) => ({ courtListenerId: Number(m[1]) }))
}

// ---------- Organ: seek-before-no ----------
// Ordering matters (audit 2026-09-25): KEYWORD hits fill evidence first (term-scored relevance),
// semantic neighbors FILL remaining slots (they are nearest-3 regardless of similarity strength,
// so they must never displace scored matches). Semantic + first keyword query run in PARALLEL.
async function seek(env, question) {
  const tried = []
  const keyword = new Map()
  const semantic = new Map()
  let lanesTried = 0, lanesFailed = 0
  const queries = [question]
  const words = question.split(/\s+/).filter((w) => w.length > 3)
  if (words.length > 2) queries.push(words.slice(0, 6).join(' '))
  if (words.length > 4) queries.push(words.slice(-5).join(' '))

  const runKeyword = async (q) => {
    lanesTried++
    try {
      const hits = await searchOpinions(env, q, 5)
      tried.push(`${q} [via ${hits.lane || '?'}]`)
      // zero-score rows are arbitrary tail — shipping them as evidence costs ~9¢ of full opinions
      // on no-match questions and dilutes real hits (audit S5; mirrors the verifyCitation filter)
      for (const h of hits || []) if (h && (h._score || 0) > 0 && !keyword.has(h.courtListenerId)) keyword.set(h.courtListenerId, h)
    } catch (e) { lanesFailed++; tried.push(`${q} [search failed: ${String(e.message).slice(0, 40)}]`) }
  }
  const runSemantic = async () => {
    lanesTried++
    try {
      const sem = await semanticSearch(env, question, 3)
      tried.push(`semantic [via embeddings-index: ${sem.length} hits]`)
      for (const h of sem) if (!semantic.has(h.courtListenerId)) semantic.set(h.courtListenerId, h)
    } catch (e) { lanesFailed++; tried.push(`semantic [embeddings unavailable: ${String(e.message).slice(0, 30)}]`) }
  }

  await Promise.all([runSemantic(), runKeyword(queries[0])])
  // reformulations still run while keyword recall is thin — semantic hits must not starve them
  for (const q of queries.slice(1, MAX_SEARCHES)) {
    if (keyword.size >= 5) break
    await runKeyword(q)
  }
  const hits = [...keyword.values()]
  for (const h of semantic.values()) if (!keyword.has(h.courtListenerId)) hits.push(h)
  return { tried, hits, allLanesFailed: lanesTried > 0 && lanesFailed === lanesTried }
}

// ---------- The agent answer route ----------
// per-isolate banner cache: the corpus changes at ingest time, not per request
let bannerCache = { t: 0, v: null }
async function bannerCached(env) {
  if (Date.now() - bannerCache.t < 300000 && bannerCache.v) return bannerCache.v
  try { bannerCache = { t: Date.now(), v: await corpusBanner(env) }; return bannerCache.v } catch { return bannerCache.v }
}

async function answer(env, question) {
  // banner off the critical path + seek in parallel (audit: serial waterfall cost seconds/ask)
  const [banner, { tried, hits, allLanesFailed }] = await Promise.all([bannerCached(env), seek(env, question)])

  // ALL search lanes down ≠ "not in corpus" — an infra outage must never wear a corpus-boundary
  // gap (and must not burn a model call). Disclosed as retryable, never cached.
  if (allLanesFailed && hits.length === 0) {
    return { banner, searchesTried: tried, evidenceCount: 0, evidenceNote: 'search unavailable', enforcementFired: false, claims: [], summary: '', infraDown: true, gap: 'Search is temporarily unavailable — this says NOTHING about the corpus. Please retry in a minute.' }
  }

  const evidenceById = {}
  const fulls = await Promise.all(hits.slice(0, EVIDENCE_DOCS).map((h) => getFullOpinion(env, h.courtListenerId).catch(() => null)))
  hits.slice(0, EVIDENCE_DOCS).forEach((h, i) => { if (fulls[i]) evidenceById[h.courtListenerId] = fulls[i] })

  // NO SILENT CAPS (law): dynamic allocation first (small docs FULL, leftovers to the giants),
  // and any remaining truncation is counted and DISCLOSED — a cut opinion must never read as "the corpus
  // doesn't address it" (dissents live at the END; caught 2026-09-25 when a gap note blamed the
  // corpus for our own equal-slice cut).
  const docs = Object.entries(evidenceById).map(([id, e]) => ({ id, e, clean: String(e.fullText).replace(/([A-Za-z])-\s*\n\s*(?=[a-z])/g, '$1') }))
  docs.sort((a, b) => a.clean.length - b.clean.length) // smallest first: they take only what they need
  let remaining = TOTAL_EVIDENCE_CHARS
  let truncatedCount = 0, storageCapped = 0
  const parts = []
  const verifyMap = {} // per-doc squeezed text, computed ONCE (CPU audit: per-claim recompute on 500k strings)
  const cleanById = {} // original cleaned text, for on-page verification receipts (audit M7)
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]
    const fair = Math.max(MIN_SLICE, Math.floor(remaining / (docs.length - i)))
    const alloc = Math.min(d.clean.length, fair)
    remaining -= alloc
    const cut = d.clean.length > alloc
    if (cut) truncatedCount++
    if (d.clean.length >= 495000) storageCapped++ // ingest stores at most 500k — disclose, never imply "full"
    // head+tail windowing on cut docs: dissents/concurrences live at the END of an opinion, so a
    // cut doc keeps its opening AND its ending — only the MIDDLE is omitted, and loudly.
    const body = cut
      ? `${d.clean.slice(0, Math.floor(alloc * 0.6))}\n\n[... MIDDLE OF OPINION OMITTED (${d.clean.length - alloc} chars) — text below resumes near the end of the document, where concurrences and dissents appear ...]\n\n${d.clean.slice(d.clean.length - Math.floor(alloc * 0.4))}`
      : d.clean
    // DUAL-CHECK verification map (audit): sqShown = what the model was actually handed;
    // sqFull = the whole stored opinion. A quote must live in BOTH.
    verifyMap[Number(d.id)] = { sqShown: squeeze(body), sqFull: squeeze(d.clean) }
    cleanById[Number(d.id)] = d.clean
    parts.push(`<opinion courtListenerId="${d.id}" case="${d.e.caseName}" court="${d.e.court}" filed="${d.e.dateFiled}" status="${d.e.precedentialStatus}"${cut ? ' middleOmitted="true — opening and ending included; do not quote across the omission marker"' : ''}>\n${body}\n</opinion>`)
  }
  const evidenceBlock = parts.join('\n\n')
  const evidenceNote = (truncatedCount
    ? `${docs.length - truncatedCount} of ${docs.length} opinions read in full; ${truncatedCount} read head+tail (middle omitted, endings incl. dissents in-window)`
    : `all ${docs.length} opinions read in full`) + (storageCapped ? `; ${storageCapped} at the 500k-char storage cap` : '')

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
    // tame the model's shape at the single write site (audit: claims:"none" crashed downstream;
    // clusterId coin-flips; extra keys must never survive to the spread)
    const tame = (o) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return { claims: [], gap: 'model returned no parseable answer', summary: '' }
      const claims = (Array.isArray(o.claims) ? o.claims : []).filter((c) => c && typeof c === 'object').map((c) => ({
        grade: String(c.grade || 'RELATED'), statement: String(c.statement || ''), quote: String(c.quote || ''),
        caseName: String(c.caseName || ''), courtListenerId: Number(c.courtListenerId ?? c.clusterId),
      }))
      return { claims, gap: String(o.gap || ''), summary: String(o.summary || '') }
    }
    const m = txt.match(/\{[\s\S]*\}/)
    if (!m) return { claims: [], gap: 'model returned no parseable answer', summary: '' }
    try { return tame(JSON.parse(m[0])) } catch {}
    // salvage a max_tokens-truncated response: walk back to the last complete claim object and
    // re-close the JSON. Recovered claims still pass through the quote verifier like any others.
    const s = m[0]
    for (let pos = s.lastIndexOf('}'); pos > 0 && pos > s.length - 4000; pos = s.lastIndexOf('}', pos - 1)) {
      for (const closer of ['', ']}', '}]}', ']}}']) {
        try {
          const cand = JSON.parse(s.slice(0, pos + 1) + closer)
          if (cand && Array.isArray(cand.claims)) {
            console.log(`SALVAGE: recovered ${cand.claims.length} claims from truncated JSON (stop_reason=${j.stop_reason})`)
            const t = tame(cand)
            t.gap = (t.gap + ' [The answer was truncated by the response budget; complete claims were kept.]').trim()
            return t
          }
        } catch {}
      }
    }
    return { claims: [], gap: 'model response was truncated beyond recovery', summary: '' }
  }

  let out = await call()
  let violations = verifyQuotes(out.claims, verifyMap)
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
    violations = verifyQuotes(out.claims, verifyMap)
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

  // EVERYTHING displayable comes from the evidence store (server-side truth), never from model
  // output — including caseName (audit: a verbatim quote + wrong famous-case name slipped through)
  for (const c of out.claims || []) {
    const ev = evidenceById[c.courtListenerId]
    if (ev) { c.caseName = ev.caseName; c.absoluteUrl = ev.absoluteUrl; c.court = ev.court; c.dateFiled = ev.dateFiled; c.precedentialStatus = ev.precedentialStatus }
    // on-page receipt (audit M7): locate the verified quote in the opinion and ship surrounding
    // context, so "machine-verified" is inspectable, not asserted. Whitespace-flexible match on
    // the quote's opening words; absence of a receipt never blocks a verified claim.
    const clean = cleanById[c.courtListenerId]
    if (clean && c.quote) {
      try {
        const words = String(c.quote).split(/\s+/).filter(Boolean).slice(0, 8).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        const mres = words.length >= 4 ? new RegExp(words.join('[\\s\\S]{0,3}'), 'i').exec(clean) : null
        if (mres) {
          const start = Math.max(0, mres.index - 150)
          c.context = (start > 0 ? '…' : '') + clean.slice(start, mres.index + String(c.quote).length + 150).trim() + '…'
        }
      } catch {}
    }
  }

  // model fields WHITELISTED — spread-order audit: model JSON must never overwrite server truth
  return { banner, searchesTried: tried, evidenceCount: Object.keys(evidenceById).length, evidenceNote, enforcementFired: enforced, claims: out.claims || [], gap: out.gap || '', summary: out.summary || '' }
}

// ---------- The citation-verifier route (the demo button) ----------
async function verifyCitation(env, input) {
  const q = String(input || '').slice(0, 200)
  const nq = norm(q)
  // guard the name-match lane against fragments and empty-norm inputs (audit: 'United States' or
  // pure-punctuation pasted → includes('') matched the first arbitrary row → false green stamp)
  const nameMatchable = nq.length >= 10
  const byCite = await groq(env, `*[_type == "opinion" && $q in citations][0]{ caseName, citations, court, dateFiled, absoluteUrl, courtListenerId, "excerpt": summary }`, { q })
  // some ingested docs have an empty search snippet — fall back to the opinion's own text,
  // SKIPPING docket-caption boilerplate ("USCA4 Appeal: 25-4218 Doc: 58…") so the receipt a
  // judge sees is prose, not filing metadata (audit M2)
  const withExcerpt = async (m) => {
    if (!m.excerpt) {
      const full = await getFullOpinion(env, m.courtListenerId)
      if (full) {
        // CourtListener plain text hard-wraps ~80 chars/line — paragraphs are blank-line blocks,
        // so split on blank lines, un-wrap each block, and take the first real prose paragraph
        const paras = String(full.fullText || '').split(/\n\s*\n/)
          .map((p) => p.replace(/USCA4 Appeal:.*?Pg: \d+ of \d+/g, ' ').replace(/\s+/g, ' ').trim())
        const prose = paras.find((p) => p.length > 150 && !/^(\d|USCA4|PUBLISHED|UNPUBLISHED|UNITED STATES|No\.\s|Nos?\.\s|Appeal:|Doc:|Filed:|Pg:|Plaintiff|Defendant|Argued:|Decided:|Present:|Appeal from|On Writ|Syllabus|NOTE:)/i.test(p))
        m.excerpt = (prose || paras.find((p) => p.length > 80) || String(full.fullText || '').replace(/\s+/g, ' ')).trim().slice(0, 400)
      }
    }
    return m
  }
  if (byCite) return { verdict: 'FOUND_BY_CITATION', match: await withExcerpt(byCite) }
  const hits = await searchOpinions(env, q, 3)
  // FOUND_BY_NAME requires substance: the input must cover >=60% of the matched case name, or
  // contain the full case name — a fragment must never earn the green stamp
  const strong = nameMatchable && (hits || []).find((h) => {
    const hn = norm(h.caseName)
    if (!hn) return false
    return (hn.includes(nq) && nq.length >= 0.6 * hn.length) || nq.includes(hn)
  })
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
  if (RL.size > 3000) RL.clear() // crude eviction: an IP sweep must not grow the map unbounded
  const now = Date.now()
  const fresh = (RL.get(ip) || []).filter((t) => now - t < 600000)
  fresh.push(now)
  RL.set(ip, fresh)
  return fresh.length > RATE_LIMIT
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export default {
  async fetch(request, env, ctx) {
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
        const b = await corpusBanner(env)
        if (!b) return new Response(JSON.stringify({ error: 'corpus banner unavailable' }), { status: 503, headers: cors })
        return new Response(JSON.stringify(b), { headers: cors })
      }
      if (url.pathname === '/api/ask' && request.method === 'POST') {
        if (rateLimited(ip)) return new Response(JSON.stringify({ error: 'rate limit — try again in a few minutes' }), { status: 429, headers: cors })
        // 415 on non-JSON content types forces a CORS preflight — closes the no-preflight
        // drive-by POST lane from hostile pages (audit S2)
        if (!String(request.headers.get('content-type') || '').includes('application/json')) {
          return new Response(JSON.stringify({ error: 'content-type must be application/json' }), { status: 415, headers: cors })
        }
        const { question } = await request.json()
        // typeof guard (audit: {"question":42} passed validation and burned a budget slot on a crash)
        if (typeof question !== 'string' || !question.trim() || question.length > MAX_Q) {
          return new Response(JSON.stringify({ error: `question must be a string, max ${MAX_Q} chars` }), { status: 400, headers: cors })
        }

        // cache: SHA-256 of the full trimmed/lowercased question (audit: norm() collapsed ALL
        // non-ASCII questions to one key; 480-char slices collided) + corpus version, so a
        // re-ingest invalidates old answers instead of contradicting the live banner.
        const banner = await bannerCached(env)
        const qKey = `q:${(banner && banner.ingestedAt) || 'v0'}:${await sha256(question.trim().toLowerCase())}`
        const cached = env.ASK_GUARD ? await env.ASK_GUARD.get(qKey) : null
        if (cached) return new Response(JSON.stringify({ ...JSON.parse(cached), served: 'cache' }), { headers: cors })

        // global daily budget: a shared KV counter distributed abuse can't reset. PRE-incremented
        // (small race window beats a 20s one); REFUNDED if answer() throws, so failures don't
        // drain the ration. Breaker, not a ledger — the $25 key cap is the final backstop.
        const day = 'budget:' + new Date().toISOString().slice(0, 10)
        const used = Number((env.ASK_GUARD && (await env.ASK_GUARD.get(day))) || 0)
        if (used >= DAILY_ASK_CAP) {
          return new Response(JSON.stringify({ error: `today's demo budget (${DAILY_ASK_CAP} answered questions) is spent — the citation-verifier tab still works, and the budget resets at midnight UTC` }), { status: 429, headers: cors })
        }
        // KV puts individually guarded (audit S4: the 1-write/sec/key limit must never 500 an
        // answered request, and a failed bookkeeping write must never discard a paid answer)
        if (env.ASK_GUARD) await env.ASK_GUARD.put(day, String(used + 1), { expirationTtl: 2 * 86400 }).catch(() => {})
        let out
        try {
          out = await answer(env, question)
        } catch (e) {
          if (env.ASK_GUARD) ctx.waitUntil(env.ASK_GUARD.put(day, String(used), { expirationTtl: 2 * 86400 }).catch(() => {})) // refund
          throw e
        }
        // cache write off the response path; degraded answers expire fast, infra outages never cache
        if (env.ASK_GUARD && !out.infraDown) {
          const ttl = (out.claims || []).length ? CACHE_TTL : CACHE_TTL_DEGRADED
          ctx.waitUntil(env.ASK_GUARD.put(qKey, JSON.stringify(out), { expirationTtl: ttl }).catch(() => {}))
        }
        if (!env.ASK_GUARD) out.limitsNote = 'cache/budget disabled: KV binding missing' // fail-open must be visible
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
