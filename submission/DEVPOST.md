# Devpost submission — instaboard

*Paste-ready text for the Devpost form. Track: **Agents That Do Real Work**
(reads the graph, fixes a data problem — knowledge rot — and writes results
back). Tagline and description below.*

---

**Tagline (60 chars):**
Capture leaving engineers' knowledge in DataHub — and know when it goes stale.

---

## Inspiration

Every data team has the same two failures. Someone joins and spends three weeks
finding out which of the four revenue tables is the real one. Someone leaves and
takes with them the reason step 2 exists — the thing that was never in any doc.

The usual fix is "write it in the wiki," and it fails for a reason nobody
addresses: the wiki can't tell you when it's wrong. Six months later the column
is renamed, the table is deprecated, the owner has left — and the runbook reads
exactly as confidently as the day it was written. Institutional knowledge that
can't tell you it's stale is a liability.

DataHub is the one place that *knows* what changed. So we built the knowledge
capture loop on top of the catalog — and closed it with the catalog.

## What it does

**instaboard** is a DataHub-native agent for onboarding and knowledge handoff,
with three connected loops:

- **Capture** — someone leaving hits ● Record in our Chrome side panel and just
  *does the task* inside DataHub. Every page they visit becomes a step; they
  annotate the "why." The agent enriches each step from the live catalog —
  owners, real saved SQL, lineage, health — and writes the finished runbook back
  into DataHub via the MCP `save_document` tool, linked to the datasets it
  touches.
- **Inherit** — someone joining replays the runbook step by step in the side
  panel, *next to* the DataHub UI, with a live "you're on this page" indicator
  and per-step "ask the coach" grounded in the same catalog.
- **Validate** — because captured knowledge rots, instaboard re-checks every
  runbook against live DataHub: columns that vanished (and whether the step's
  SQL actually references them), tables deprecated since recording, newly
  failing assertions, open incidents, owners who no longer own the thing.
  Findings are **written back to the catalog** as a Note linked to the affected
  datasets — the staleness warning lives where the data lives. Detection is
  deliberately deterministic (a schema diff plus a health read, no LLM), so
  every "this is broken" verdict can be confirmed in the DataHub UI in ten
  seconds.

Around that core: a chat assistant grounded in catalog metadata with a visible
MCP tool trace, a week-1 learning path generator built from real 30-day usage
stats (write-back-able so the next hire finds it), a lineage explainer with
blast-radius briefings, health-aware recommendations that refuse to point a new
hire at a deprecated table, and documentation-gap write-back (missing
descriptions become `DescriptionProposal` documents for owners to review).

## We measured whether the catalog actually helps

`evals/` holds a 20-question onboarding benchmark — the questions a real new
hire asks in week 1 — scored **deterministically** against the catalog: every
check is a substring match on facts that live in DataHub (real URNs, owners,
columns). No LLM judge, no partial credit. The same 20 cases run twice through
the identical agent loop; the only variable is whether the DataHub MCP tools are
in the tool list.

Result: **15/20 with DataHub vs 5/20 without.** Half the questions a new hire
asks in week 1 are answerable *only* with the catalog. The control isn't a
strawman — it's a capable assistant prompted to name specific tables, owners,
and SQL; it just has no context. Full scorecard with every raw answer is
committed in the repo.

## How we built it

Next.js app + Chrome side-panel extension sharing one backend. The backend
spawns the official `mcp-server-datahub` (with mutations enabled), hands the
LLM the live MCP tool list, and streams every tool call and result to the UI.
Runbook decay detection snapshots the catalog facts each step depends on at
record time, then diffs them against live DataHub on demand. A zero-setup demo
mode answers every MCP call from a built-in fixture of the same catalog our
seed script creates, so judges can run the full product — including the eval
benchmark — with no Docker and a free-tier API key.

**DataHub technologies used:** DataHub MCP Server (search, get_entities,
get_lineage, get_dataset_queries, get_dataset_health, get_usage_stats,
save_document with mutations enabled), DataHub docker quickstart, Python SDK
ingestion (seed script for the Northbeam demo catalog: 14 datasets, lineage,
glossary, assertions, incidents, saved queries).

## Challenges we ran into

- Live MCP responses and our fixture differ in shape; the decay engine
  deep-scans for the keys it needs instead of assuming a layout, so the same
  deterministic diff runs against both.
- A 20-case × 2-arm benchmark is ~80 LLM calls — more than most free tiers allow
  in one sitting. The runner caches every completed case and resumes across
  quota walls, so the benchmark is reproducible on a $0 key.
- Making "the agent wrote something back" trustworthy: we kept every write-back
  human-legible (markdown documents with URNs) and every decay verdict
  LLM-free, so nothing instaboard writes into your catalog is a guess.

## Accomplishments we're proud of

- The full loop closes: knowledge is captured *from* the catalog, written
  *into* the catalog, and invalidated *by* the catalog.
- A measured, reproducible answer to "does DataHub grounding matter?" —
  15/20 vs 5/20, deterministically scored, auditable by hand.
- The Chrome side panel makes DataHub itself the recording studio — no
  new tool to learn on the worst week to learn one (your last).
- 44 tests, demo mode with zero infrastructure, and every judge-facing claim
  reproducible from a clean clone.

## What we learned

Metadata isn't documentation — it's the *test suite* for documentation. Once
the catalog holds owners, schemas, assertions, and lineage, any prose that
references them becomes checkable. That inversion (docs validated by metadata,
not the other way around) is the idea we'd take to production.

## What's next

Scheduled re-validation (cron, not on-demand) with owner notifications when a
runbook breaks; capturing handoffs from query history, not just page trails;
and upstreaming the runbook document type so any DataHub client can render
step-by-step replays.

---

*Built solo during the submission period. Apache 2.0.*
