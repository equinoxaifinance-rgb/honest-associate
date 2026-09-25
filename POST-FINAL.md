---
title: "Honest Associate: a legal research agent that structurally cannot cite a fake case"
published: false
tags: devchallenge, sanitychallenge, sanity, ai
---

*This is a submission for the [Sanity Challenge](https://dev.to/challenges/sanity-2026-09-16): Path One — Ship an Agent That Queries Real Content.*

## What I Built

In 2023, lawyers were sanctioned for filing a brief full of cases ChatGPT invented. *Varghese v.
China Southern Airlines* became the most famous court case that never existed.

Paste that exact citation into my agent's verify tab and it answers in half a second:

![NOT IN CORPUS — the fabricated Varghese citation rejected with a red stamp](https://honest-associate.neoaethel.workers.dev/media/varghese-stamp.jpg)

**NOT IN CORPUS.** And unlike a chatbot, it cannot be talked out of that answer — because the
answer comes from a database query, not a model's memory.

**Honest Associate** is a legal research agent over 350 real published court opinions (every
SCOTUS decision June 2025 → Sept 2026, plus 250 published Fourth Circuit decisions), ingested
from CourtListener (Free Law Project, public domain) into a Sanity dataset. Its one design rule:
**trust is a property of the system, not a promise from the model.** The model only drafts.
Everything that makes it trustworthy is mechanical:

- **Mechanical quote verification** — every claim must carry a verbatim quote; code (not the
  model) checks it exists letter-for-letter in *both* the text the model was shown *and* the
  stored opinion. Failures are rejected, retried once with the violations named, then stripped.
- **Withheld summaries** — zero surviving claims = no summary. An unsupported answer never wears
  the tool's credibility.
- **Server-truth labels** — case names, dates, courts, links come from the database record. The
  model cannot invent a URL or mislabel a case.
- **Verification receipts** — every verified quote ships with the surrounding opinion text, so
  "machine-verified" is inspectable, not asserted:

![A verified claim opened to show its receipt — the quote sitting inside the real opinion text](https://honest-associate.neoaethel.workers.dev/media/verification-receipt.jpg)

- **Honest edges** — "not in corpus" is a statement about this collection, never the world; gaps
  say what the corpus can't answer; evidence truncation is disclosed per answer.

### The proof: we turned the verifier off

Same model (claude-haiku-4-5), same prompt (the rules still *written* in it), same evidence,
10 questions × 5 repeats per arm. The only variable: does the mechanical layer **enforce**, or
just observe?

| | Prompt-only | Enforced |
|---|---|---|
| Fabricated/altered quotes reaching the user | **18** | **0** |
| Runs with ≥1 fabrication shipped | **11 / 50 (22%)** | **0 / 50** |

Without enforcement the model shipped altered "quotes" — including spans invoking *Yoder* and
*Barnette*, famous cases it knows from training, that do **not** appear verbatim in the opinions
it cited. It read the rule "anything not in the evidence does not exist for you" and broke it
anyway, in 11 of 50 runs. Prompt discipline is intermittent. The mechanical layer is not.
Raw per-run receipts are committed in the repo (`agent/ablation-results.jsonl`).

We also caught the enforced model live: it "quoted" the birthright-citizenship opinion as Congress
having **granted** equitable authority where the text says **given** — one swapped word inside a
direct quote, with the full text in its context. The verifier rejected it mechanically. That log
is in the repo too.

## Demo

**Live (no login needed):** https://honest-associate.neoaethel.workers.dev

One-tap demos, shareable as deep links:
- The fabricated case, rejected: [`?cite=Varghese v. China Southern Airlines…`](https://honest-associate.neoaethel.workers.dev/?cite=Varghese%20v.%20China%20Southern%20Airlines%20Co.%2C%20925%20F.3d%201339%20(11th%20Cir.%202019))
- A real question, machine-verified: [`?q=What did the Supreme Court hold about universal injunctions?`](https://honest-associate.neoaethel.workers.dev/?q=What%20did%20the%20Supreme%20Court%20hold%20about%20universal%20injunctions%3F)

![The machinery, explained on the page itself](https://honest-associate.neoaethel.workers.dev/media/how-it-stays-honest.jpg)

(Uncached questions take ~20–40s — the verifier reads whole opinions. The demo runs on a
spend-capped key with a daily ration; the verify tab is unmetered, hammer it freely.)

## Code

https://github.com/equinoxaifinance-rgb/honest-associate

Worker (agent + verifier + UI), ingest pipeline, Studio schema, and the test drivers — including
the ablation driver and the engine-swap pilot. MIT-spirited; court data is public domain via the
Free Law Project.

## How I Used Sanity

The challenge's Path One allows agents to "point your agent at your full dataset through a
Context MCP endpoint with embeddings enabled" — that's this build, literally:

1. **Sanity dataset as the corpus** (project `0b9qmvox`, dataset `production`): an `opinion`
   document type whose schema *is* the trust architecture — required `caseName`/`dateFiled`/
   `courtListenerId`, full text for verification, plus a `corpusInfo` singleton that the UI
   banner renders from **census-measured values** (a script counts the data layer and writes the
   banner; nothing is typed by hand).
2. **Sanity Context MCP endpoint** (`honest-associate-opinions`, Dataset mode, GROQ-filtered to
   our document types): the agent's keyword searches run through the endpoint's `groq_query`
   tool over MCP — every response tags them `[via context-mcp]`. Direct GROQ exists only as a
   *disclosed* fallback.
3. **Embeddings enabled over the full corpus**: a Sanity embeddings index on all 350 opinions
   powers the semantic lane — a paraphrase like "the order ending birthright citizenship" finds
   *Trump v. CASA* with zero case-name words, tagged `[via embeddings-index]`.
4. **Studio v5 deployed** for content inspection (and required by Context).

**Honest note on Knowledge Bases** (a judging criterion, so you hear it from us): we built a KB,
then deleted it — the free tier indexes 150 documents and even our 101-doc SCOTUS subset expanded
to 402 chunks. Rather than gut the corpus to decorate a checkbox, we took the challenge's own
full-dataset route and put semantic recall on the embeddings index. KBs are our paid-tier upgrade
path.

## Sanity Project Details

- **Project ID:** `0b9qmvox` · dataset `production`
- MCP endpoint: `https://api.sanity.io/v1/context/organizations/oq358bde9/mcp/honest-associate-opinions`
- Embeddings index: `opinions-index` (350/350 documents, 0 failed)

## Agent Session

The agent was built end-to-end by an AI agent (Claude, in Claude Code) running under a
verification harness — and the build process *is* the product thesis: a 40-agent adversarial
audit found real holes (including one in the verifier itself), every finding was refuted or
confirmed by independent reviewers, and the fixes shipped the same night.

Excerpts of the verifier catching the model mid-fabrication, with unedited logs:
https://github.com/equinoxaifinance-rgb/honest-associate/blob/main/docs/agent-session-excerpt.md

## Why I Built This

Truthfully, we built this for a competition. But the design came from something real: I'm not a
lawyer and I'm not a trained developer — I can't personally check whether an AI is telling me the
truth. So the rule I gave this project was simple: don't just refuse to answer — become something
a lawyer can actually trust, and if you can't prove it, don't say it. Halfway through, I asked one
question that became the whole entry: turn the safety layer off and see if it makes things up. It
did — 18 times in 50 runs. That's why the trust here isn't a promise in a prompt. It's code.

---

**Honest limits, so you don't have to hunt for them:** the corpus is a bounded snapshot (SCOTUS +
CA4, mid-2025→late-2026) — a real product needs every circuit, state courts, and statutes, which
is ingest scale, not new architecture. Quote verification proves a quote exists in the cited
opinion; claim *grades* (DIRECT_QUOTE / SUPPORTED / RELATED) are model-assigned. Opinions are
stored to a 500k-character cap (disclosed per answer when hit). This is a research aid, not legal
advice.

*Public-domain court data courtesy of the Free Law Project / CourtListener. Not affiliated.*
