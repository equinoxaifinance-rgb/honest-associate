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
| **Context MCP retrieval** | Searches run through the [Sanity Context](https://www.sanity.io/docs/context) MCP endpoint (`groq_query` tool). Every response tags its searches `[via context-mcp]`; direct GROQ exists only as a *disclosed* fallback. |
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

Without enforcement, the model shipped "quotes" from *Yoder* and *W.Va. Bd. of Ed. v. Barnette* —
real, famous cases it knows from training that were **not in the evidence it cited**. The written
rule said "anything not in the evidence does not exist for you." It read the rule and broke it
anyway. Prompt discipline is intermittent; the mechanical layer is not.
Raw per-run receipts: `agent/ablation-results.jsonl`. Driver: `agent/test-ablation.mjs`.

We also swapped the engine for a free 4B local model (qwen3-4b on a consumer GPU) under the same
wrap: thinner answers, 25× slower — and the same zero-fabrication floor. The trust layer is
engine-agnostic; capability is a cost knob. Driver: `agent/test-engines.mjs`.

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
- The Knowledge Base semantic layer covers the SCOTUS subset (free-tier document limit); the GROQ
  lane covers the full corpus.
- This is a research aid, not legal advice.

Public-domain court data courtesy of the Free Law Project. Not affiliated with CourtListener.
