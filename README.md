# Honest Associate

**Legal research that structurally cannot cite a case that doesn't exist.**

Live demo: https://honest-associate.neoaethel.workers.dev
Built for the [dev.to Sanity Challenge](https://dev.to/challenges) (Path One: agent + Sanity Context MCP).

In 2023, lawyers were sanctioned for filing a brief full of cases ChatGPT invented. Paste the most
famous of them — *Varghese v. China Southern Airlines* — into this agent's citation verifier and it
answers **NOT IN CORPUS** in half a second. It cannot be talked out of that answer, because the
answer comes from a database query, not a model's memory.

## The thesis: trust as a property of the system, not a promise from the model

None of this agent's honesty guarantees live in the model. The model only drafts. Everything that
makes it trustworthy is mechanical:

| Organ | What it does |
|---|---|
| **Bounded corpus** | 350+ real published opinions (SCOTUS + Fourth Circuit) ingested from [CourtListener](https://www.courtlistener.com/) (Free Law Project, public domain) into Sanity. The UI banner (count, courts, date range) is written by a census script from measured data-layer values — never typed by hand. |
| **Three retrieval lanes, all disclosed** | Semantic recall via a Sanity **embeddings index** over the full corpus (a paraphrase like "the order ending birthright citizenship" finds *Trump v. CASA* with zero case-name words), plus keyword search through the [Sanity Context](https://www.sanity.io/docs/context) MCP endpoint (`groq_query` tool) — every response tags each search `[via embeddings-index]` / `[via context-mcp]`; direct GROQ is the *disclosed* fallback. Document fetch and the banner use the Sanity HTTP API. |
| **Mechanical quote verification** | Every claim must carry a verbatim quote. A string matcher (whitespace/hyphenation-forgiving, word-substitution-merciless) checks it against the stored opinion text. Fail → one retry with violations named → still failing → the claim is stripped. |
| **Withheld summaries** | If zero claims survive verification, the summary is withheld — an unsupported answer never wears the tool's credibility. |
| **Server-attached sources** | CourtListener links come from the database record, never from model output. The model cannot invent a URL. |
| **Honest edges** | "Not in corpus" is explicitly a statement about the collection, not the world. Gaps say what the corpus can't answer. |

## The ablation (the proof)

We ran the same 10 questions × 5 repeats through two arms — identical engine (claude-haiku-4-5),
identical prompt (the rules are *written* in both), identical evidence. The only variable: does the
mechanical layer **enforce**, or just observe?

| | Prompt-only | Enforced |
|---|---|---|
| Fabricated/altered quotes reaching the user | **18** | **0** |
| Runs with ≥1 fabrication shipped | **11 / 50 (22%)** | **0 / 50** |

Without enforcement, the model shipped altered "quotes" — including spans invoking *Yoder* and
*W.Va. Bd. of Ed. v. Barnette* (famous cases it knows from training) that do **not appear
verbatim in the opinions it cited**. The written rule said copy exactly and never fill from
memory. It broke it anyway — in 11 of 50 runs. Prompt discipline is intermittent; the mechanical
layer is not. Raw per-run receipts: `agent/ablation-results.jsonl`. Driver: `agent/test-ablation.mjs`.
Config disclosure: ablation ran at provider-default temperature (the live site's setting) with a
4×12k-char evidence harness; both arms share the round-1 draft, so the comparison isolates
enforcement exactly.

In a smaller 4-question pilot we also swapped the engine for a free 4B local model (qwen3-4b on a
consumer gaming GPU) under the same wrap: thinner answers (1 verified claim vs 5 on the same
question), minutes instead of seconds — and the same zero-fabrication floor in every measured
cell. Suggestive, not a benchmark: the trust floor traveled with the wrap, not the engine.
Driver: `agent/test-engines.mjs`.

## Architecture

```
CourtListener API ──(ingest/ingest.mjs: polite, idempotent, watchdogged)──► Sanity dataset
                                                                              │
   Sanity Studio (schema as trust architecture: required caseName/dateFiled/  │
   courtListenerId, fullText for verification, corpusInfo = honest banner)    │
                                                                              ▼
Cloudflare Worker (agent/worker.js) ◄──(groq_query via Sanity Context MCP endpoint)
  /api/ask    → seek-before-no → model drafts → mechanical quote verify → retry/strip/withhold
  /api/verify → FOUND_BY_CITATION / FOUND_BY_NAME / NOT_IN_CORPUS (nearest matches, honestly empty)
  /api/banner → corpusInfo (census-written, measured values only)
  + KV: global daily ask budget + question cache · per-IP rate limit · size caps
```

## Run it yourself

```bash
# ingest (needs COURTLISTENER_TOKEN + SANITY_WRITE_TOKEN in ../.env)
cd ingest && node ingest.mjs --court scotus --max 100 && node census.mjs

# agent (needs ANTHROPIC_API_KEY + SANITY_CONTEXT_TOKEN in .dev.vars)
cd agent && npx wrangler dev
# test batteries
node test-battery.mjs && node test-live.mjs && node test-ablation.mjs
```

## Honest limits (we'd rather you hear them from us)

- The corpus is a bounded snapshot (SCOTUS + CA4, mid-2025 → late-2026). A real product needs every
  circuit, state courts, and statutes — that's ingest scale, not new architecture.
- Quote verification proves a quote exists in the cited opinion; it does not prove the *claim*
  fairly characterizes the opinion. Grades (DIRECT_QUOTE/SUPPORTED/RELATED) are model-assigned.
- We tried Sanity's Knowledge Base layer and **deleted it**: the free tier indexes 150 documents
  and even our 101-doc SCOTUS subset expanded to 402 indexed chunks. Instead, semantic recall runs
  on a Sanity **embeddings index over all 350 opinions** (the challenge's sanctioned full-dataset
  route), and the Context MCP endpoint serves the corpus in Dataset mode. KBs are the paid-tier
  upgrade path, and we'd rather tell you that than gut the corpus to decorate a checkbox.
- Opinions are stored up to a 500k-character cap (disclosed per answer when hit).
- This is a research aid, not legal advice.

Public-domain court data courtesy of the Free Law Project. Not affiliated with CourtListener.
