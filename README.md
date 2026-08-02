# ⚡ instaboard

[![ci](https://github.com/mcrowley19/Instaboard/actions/workflows/ci.yml/badge.svg)](https://github.com/mcrowley19/Instaboard/actions/workflows/ci.yml)
*CI re-scores the committed benchmark answers on every push — a green badge
means the published 19/20 vs 5/20 is reproducible, not just claimed.*

**When a data engineer leaves, their knowledge leaves with them. instaboard captures
it into DataHub — and tells you when it goes stale.**

Every data team has the same two failures. Someone joins and spends three weeks
finding out which of the four revenue tables is the real one. Someone leaves and
takes with them the reason step 2 exists — the thing that was never in any doc.

instaboard is a DataHub-native agent for both halves of that problem:

- **Capture** — someone leaving hits ● Record and just *does the task* in DataHub.
  Every page becomes a step; they annotate the "why." The agent enriches each step
  from the live catalog (owners, real SQL, lineage, health) and writes the finished
  runbook back into DataHub via `save_document`.
- **Inherit** — someone joining replays it step by step in a side panel *next to
  DataHub*, with a live "you're on this page" indicator and per-step "ask the coach."
- **Validate** — and because captured knowledge rots, instaboard re-checks every
  runbook against live DataHub: columns that vanished, tables since deprecated,
  assertions now failing, owners who no longer own the thing. Findings are written
  back to the catalog so the staleness is visible where the runbook lives.

That last loop is the point. Institutional knowledge that can't tell you it's wrong
is a liability, and it's the part every "write it to the wiki" workflow gets wrong.

---

## Does grounding in DataHub actually help? We measured it.

`evals/` holds a 20-question onboarding benchmark — the questions a real new hire
asks in week 1 — scored **deterministically** against the catalog. Every check is a
substring match on facts that live in DataHub (real URNs, real owners, real columns).
No LLM judge, no partial credit: a case passes only if every one of its checks passes.

The same 20 cases run twice through the **identical agent loop** (`lib/agent.ts`).
The only variable is whether the DataHub MCP tools are in the tool list:

```bash
DEMO_MODE=true npm run eval      # no DataHub, no Docker
```

Results are committed at [`evals/results/scorecard.md`](evals/results/scorecard.md),
with every raw answer in `latest.json` so any check can be audited by hand.

**It runs on a free API key.** A full run is ~80 LLM calls — more than most free
daily quotas allow in one sitting — so every completed case is cached and a re-run
resumes where it stopped. Hitting a quota wall pauses the run instead of losing it.

```bash
# free, tool-calling capable, no card required
LLM_PROVIDER=openrouter  LLM_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
# or Google AI Studio's free tier
LLM_PROVIDER=gemini      LLM_MODEL=gemini-2.5-flash
```

Add `--concurrency=1` if your provider is strict about requests per minute, and
`--fresh` to ignore the cache. `npm run eval -- --arm=grounded` runs one arm.

The control arm is deliberately **not** a strawman — it gets a neutral, capable-assistant
prompt asking for specific tables, owners, and SQL. It's the honest counterfactual:
an off-the-shelf chatbot, which is what a new hire actually reaches for today. Both
prompts are in `evals/run.ts`.

What the catalog buys you, by category:

| Category | What it tests |
| --- | --- |
| `grounding` | Does it name the real table, with the real URN? |
| `ownership` | The actual owner, or a plausible-sounding invention? |
| `lineage` | The real blast radius of a column change |
| `health-trap` | The obvious answer is a **deprecated** table. Does it notice? |
| `usage` | Ranks by real 30-day query volume, not catalog structure |
| `glossary` | *This company's* MRR definition, not the textbook one |
| `sql` | The saved query analysts run, not a plausible reconstruction |
| `hallucination` | Asked about a table that doesn't exist — does it say so? |

`EVAL_MIN_PASS=n npm run eval` exits non-zero below a threshold, so it works as a CI gate.

---

## Two surfaces, one backend

- **Web app** — chat, learning paths, lineage explainer, handoffs, progress
- **Chrome side panel** — follows you *inside* DataHub, detects the entity on
  screen, records handoffs, replays them ([install](extension/README.md))

## Features

- **🔁 Handoffs** — the headline. Record a task by doing it; the agent turns the
  trail plus your notes into a catalog-grounded runbook, saved locally **and
  written back into DataHub**, linked to the datasets it touches. Replayed
  step-by-step by whoever inherits it.
- **🕰️ Runbook decay detection** — one click re-validates a runbook against live
  DataHub, or run the whole sweep unattended: `npm run validate` checks every
  stored runbook, writes drift notes back to the catalog with a document-URN
  receipt, and exits non-zero on broken runbooks — cron it and the decay loop
  runs itself. Deterministic: a schema diff plus a health read, no LLM guessing, so a
  "this is broken" verdict is something you can confirm in the DataHub UI in ten
  seconds. Detects vanished entities, **removed columns the runbook's SQL actually
  references**, newly-deprecated tables, new incidents, newly-failing assertions,
  and owners who have moved on. Drift is written back to the catalog as a note.
- **💬 Chat assistant** — plain-English Q&A grounded in DataHub metadata, with
  every MCP call visible in an expandable tool trace.
- **🩺 Data health awareness** — checks `get_dataset_health` before recommending a
  table, and leads with ⚠️ plus the safe alternative instead of confidently
  answering from a dead one.
- **📈 Usage-aware ranking** — `get_usage_stats` lets the agent prefer tables
  people actually query over ones that merely exist in the domain.
- **🕸️ Glossary graph** — metrics explained in relation to each other (MRR ↔ ARR ↔
  Churn Rate) via `relatedTerms`, not in isolation.
- **✍️ Documentation gap write-back** — when a description is missing or too thin,
  the agent drafts one from the schema/lineage/usage it already fetched and files
  it as a `DescriptionProposal` for an owner to review.
- **🗺️ Week-1 learning path generator** — role + domain → a 5-day plan built from
  live catalog exploration and real usage stats, with deprecated tables excluded.
  One click writes it back to DataHub so the *next* hire finds it.
- **🔀 Lineage explainer** — upstream, downstream, health summary, and an "impact
  if changed" briefing with owners to talk to.
- **✅ Progress tracker** — check off items as you ramp.

## For judges: the 5-minute path

1. **Run it with zero infrastructure** — use the hosted demo at
   [instaboard-mu.vercel.app](https://instaboard-mu.vercel.app)
   (paste any LLM key in Settings), or locally: `npm install`,
   `echo "DEMO_MODE=true" > .env.local`, `npm run dev`. Full product, no Docker.
2. **See the headline loop** — `/handoffs` → the sample runbook → **Validate
   against DataHub**: a deterministic staleness verdict on step 1, written back
   to the catalog with a receipt carrying the document URN DataHub reports.
   The exact document it writes is committed at
   [`examples/decay-writeback-note.md`](examples/decay-writeback-note.md) —
   generated by the real code path, not by hand. `npm run validate` runs the
   same sweep unattended across every runbook.
3. **See the measurement** — [`evals/results/scorecard.md`](evals/results/scorecard.md):
   the same agent scores **19/20 with DataHub's MCP tools vs 5/20 without**, on
   deterministic substring checks against real catalog facts. Every raw answer
   is in `latest.json`; `npm test` runs 44 unit tests.

Where this sits against the judging criteria: **Use of DataHub** — reads seven
MCP tools and writes back four document kinds (runbooks, decay notes, learning
paths, description proposals), so the graph improves with every use.
**Originality** — knowledge capture/replay/decay is an onboarding product, not
another lineage guard; the Chrome side panel makes DataHub itself the recording
surface. **Technical execution** — deterministic decay engine, resumable
free-tier eval runner, one agent loop shared by app, extension, and benchmark.
**Real-world usefulness** — the two weeks around every departure and every new
hire, which every data platform team pays for today.

## Quick start

### Fastest path: demo mode (no DataHub needed)

```bash
npm install
echo "DEMO_MODE=true" > .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste an LLM key in
**Settings** (Anthropic / OpenRouter / Gemini), and ask *"How do we calculate MRR?"*

Demo mode answers every DataHub tool call from a built-in fixture of the same
Northbeam catalog the seed script creates — same datasets, owners, lineage,
glossary, health signals, and saved SQL. The full agent loop, tool traces, learning
paths, lineage explainer, handoff replay, and **the eval harness** all work with
zero infrastructure. The sidebar pill shows **Demo catalog** so the mode is never
ambiguous.

**Try the decay loop in demo mode:** open `/handoffs` → the sample runbook →
**Validate against DataHub**. It flags step 1: `payment_health_daily`'s freshness
assertion started failing *after* Priya recorded the runbook, so following that
step as written would mislead you. That finding is then written back to DataHub.

### Against a real DataHub

<details>
<summary>Full local setup (Docker + seeded catalog)</summary>

**1. Install** — `npm install`, plus [uv](https://docs.astral.sh/uv/getting-started/installation/)
(`curl -LsSf https://astral.sh/uv/install.sh | sh`) which runs the DataHub MCP
server and the seed script.

**2. Run DataHub** — `npm run datahub:up` (wraps `datahub docker quickstart`;
GMS on `:8080`, UI on `:9002`). First run pulls several images.

**3. Seed the demo catalog** — `npm run seed`. Seeds **Northbeam**, a fictional
subscription-commerce company: 14 datasets across postgres + snowflake with full
schemas and docs, 4 owners, 3 domains, PII/Tier1/Finance tags, a metrics glossary,
lineage across 4 pipelines, and 5 saved SQL queries. Verify at
[http://localhost:9002](http://localhost:9002) (`datahub` / `datahub`).

**4. Configure** — `cp .env.example .env.local`. Defaults work for a local
quickstart; set `DATAHUB_GMS_TOKEN` if your DataHub requires auth.

**5. Add an LLM key** — in **Settings** in the app (stored in browser localStorage,
forwarded to your own server per request), or `LLM_PROVIDER` / `LLM_API_KEY` in
`.env.local`. No keys are hardcoded or committed.

**6. Run** — `npm run dev`. Run the benchmark against live DataHub with
`npm run eval -- --live`.

</details>

## Try these

| Ask | What happens |
| --- | --- |
| What tables do we use for revenue? | `search` → `get_entities` → cites `fct_revenue`, `mrr_monthly` with owners & URNs |
| Who owns the payments pipeline? | reports actual owners (Priya Patel et al.) |
| What breaks if I change users.email? | `get_lineage` downstream walk → impacted marts + who to warn |
| Is it safe to build a report on the raw events table? | `get_dataset_health` → ⚠️ deprecated, points to `events_sessionized` |
| Which Payments tables should I learn first? | `get_usage_stats` ranks by real 30-day query volume |
| What columns are in our marketing_attribution table? | says it isn't in the catalog instead of inventing a schema |

## Architecture

```
┌──────────────────────────────┐   ┌────────────────────────────────┐
│  Next.js UI (light, streamed)│   │  Chrome extension (side panel) │
│  chat · path · lineage ·     │   │  context capture on DataHub ·  │
│  handoffs · progress         │   │  record / replay · same chat   │
└──────────────┬───────────────┘   └───────────────┬────────────────┘
               │ fetch (NDJSON event stream)       │ fetch + {message, context}
┌──────────────▼───────────────────────────────────▼───────┐
│  API routes (app/api/*)                                  │
│  /chat · /learning-path · /lineage · /handoffs ·         │
│  /handoffs/[id]/verify · /save-document · /health        │
│  ┌────────────────────────┐  ┌─────────────────────────┐ │
│  │ Agent loop (lib/agent) │  │ Decay engine (lib/decay)│ │
│  │ LLM ⇄ tools until done │  │ deterministic diff      │ │
│  └───┬────────────────────┘  └───────────┬─────────────┘ │
│  LLM providers (retry/backoff)   MCP client (singleton)  │
└──────────────────────┼───────────────────────────────────┘
                       │ spawns: uvx mcp-server-datahub
            ┌──────────▼──────────┐
            │  DataHub MCP Server │  search · get_entities · get_lineage ·
            └──────────┬──────────┘  get_dataset_queries · save_document …
                       │ GraphQL/REST
            ┌──────────▼──────────┐
            │  DataHub GMS :8080  │
            └─────────────────────┘
```

- The MCP server is spawned once per server process with
  `TOOLS_IS_MUTATION_ENABLED=true` so write-back works.
- The agent loop hands the LLM the **live** MCP tool list, executes every call
  against DataHub, and streams `tool_call` / `tool_result` / `text` events.
- Provider calls retry transient 429/5xx with exponential backoff and jitter.
- **The decay engine deliberately does not use an LLM.** Detection is a schema diff
  plus a health read against snapshots captured at record time, so every finding is
  independently verifiable.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | start the app on :3000 |
| `npm run build` / `npm start` | production build / serve |
| `npm test` | vitest suite (44 tests, MCP mocked) |
| `npm run eval` | the 20-case onboarding benchmark, both arms |
| `npm run eval:verify` | re-score the committed answers — CI runs this on every push |
| `npm run validate` | sweep every runbook for decay, write drift notes back to DataHub |
| `npm run seed` | seed the Northbeam demo catalog into DataHub |
| `npm run datahub:up` / `datahub:down` | start / stop the local DataHub stack |

## Project layout

```
app/            page.tsx (landing) · (app)/ signed-in pages · api/ routes
components/     Sidebar, ToolTrace, Markdown, SettingsModal
lib/            mcp.ts (MCP client) · agent.ts (loop) · decay.ts (validation)
                providers.ts (LLMs) · prompts.ts · demo-catalog.ts · demo-mcp.ts
evals/          benchmark.ts (20 cases) · score.ts · run.ts · results/
extension/      Chrome side panel
scripts/        seed_datahub.py — demo catalog ingestion
tests/          vitest suite
```

## Security notes

- `.env*`, `*.key`, and `credentials.json` are gitignored; the repo ships only
  `.env.example` with placeholders.
- API keys pasted in the UI live in browser localStorage and are forwarded as
  request headers to *your own* Next.js server only. Nothing is sent anywhere else.

## Troubleshooting

- **Sidebar says "DataHub offline"** — GMS isn't reachable. Check `docker ps`, then
  `curl http://localhost:8080/health`. The status pill polls every 30s.
- **"No LLM configured"** — add a key in Settings or `.env.local`.
- **`npm run eval` exits immediately** — it needs `LLM_PROVIDER` and `LLM_API_KEY`
  in `.env.local` (the UI's localStorage key isn't visible to the CLI).
- **First MCP call is slow** — `uvx` resolves `mcp-server-datahub` on first use.

## License

[Apache 2.0](LICENSE).
