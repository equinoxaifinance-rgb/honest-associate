#!/usr/bin/env node
// Census + corpus banner: counts every stored opinion against the ingest contract at the DATA
// LAYER (GROQ over the live dataset), then writes the corpusInfo document from MEASURED values.
// PORTED-FROM: ingest.mjs (client config, env token pattern). The banner never states a number
// the census didn't count — honest edges are measured, not typed.
// Usage: SANITY_WRITE_TOKEN=... node census.mjs
import { createClient } from '@sanity/client'

const TOKEN = process.env.SANITY_WRITE_TOKEN
if (!TOKEN) { console.error('SANITY_WRITE_TOKEN missing'); process.exit(1) }
const sanity = createClient({ projectId: '0b9qmvox', dataset: 'production', apiVersion: '2025-01-01', token: TOKEN, useCdn: false })

const total = await sanity.fetch('count(*[_type == "opinion"])')
const complete = await sanity.fetch(
  'count(*[_type == "opinion" && defined(caseName) && defined(court) && defined(dateFiled) && defined(fullText) && defined(courtListenerId) && defined(absoluteUrl) && length(fullText) >= 500])'
)
const byCourt = await sanity.fetch('{"scotus": count(*[_type=="opinion" && court=="scotus"]), "ca4": count(*[_type=="opinion" && court=="ca4"])}')
const dates = await sanity.fetch('{"min": *[_type=="opinion"] | order(dateFiled asc)[0].dateFiled, "max": *[_type=="opinion"] | order(dateFiled desc)[0].dateFiled}')
const shortest = await sanity.fetch('*[_type=="opinion"] | order(length(fullText) asc)[0]{ "len": length(fullText), caseName }')

console.log('=== CORPUS CENSUS (data layer, GROQ over live dataset) ===')
console.log(`total opinions:        ${total}`)
console.log(`contract-complete:     ${complete} (all required fields + fullText >= 500 chars)`)
console.log(`contract violations:   ${total - complete}`)
console.log(`by court:              scotus=${byCourt.scotus} ca4=${byCourt.ca4}`)
console.log(`date range:            ${dates.min} -> ${dates.max}`)
console.log(`shortest fullText:     ${shortest?.len} chars (${shortest?.caseName})`)

if (total - complete > 0) {
  const bad = await sanity.fetch('*[_type=="opinion" && !(defined(caseName) && defined(court) && defined(dateFiled) && defined(fullText) && defined(courtListenerId) && defined(absoluteUrl) && length(fullText) >= 500)][0...5]{caseName, courtListenerId}')
  console.log('violating docs (first 5):', JSON.stringify(bad))
}

await sanity.createOrReplace({
  _id: 'corpusInfo-main',
  _type: 'corpusInfo',
  title: 'Honest Associate Corpus',
  courtsCovered: ['Supreme Court of the United States (scotus)', 'Court of Appeals for the Fourth Circuit (ca4)'],
  dateRangeStart: dates.min,
  dateRangeEnd: dates.max,
  opinionCount: total,
  source: 'CourtListener / Free Law Project (public domain)',
  ingestedAt: new Date().toISOString(),
  disclaimer:
    'This corpus is a bounded snapshot. "Not in corpus" means not in THIS collection — never that no authority exists. This tool is a research aid, not legal advice.',
})
console.log('\ncorpusInfo-main written from measured values.')
