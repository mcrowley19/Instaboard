# Devpost submission — instaboard

*Paste-ready text for the Devpost form. Track: **Agents That Do Real Work**
(reads the graph, fixes a data problem — knowledge rot — and writes results
back). Tagline and description below.*

---

**Tagline (Devpost limit 120 chars):**
Capture leaving engineers' knowledge in DataHub — and know when it goes stale.

**Links for the submission form:**
- Working project URL: https://instaboard-mu.vercel.app
- Repo: https://github.com/mcrowley19/Instaboard
- Demo video: *(add YouTube link once recorded)*

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
  Findings go **back into the catalog** three ways. A drift Note linked to the
  affected datasets. A native DataHub **Incident** on anything that would now fail
  if followed. A **`Stale Runbook` tag** on everything that drifted. The warning
  lands in the workflows a data team already watches instead of in a document
  somebody has to open. There is no LLM in the detection; it diffs the schema and
  reads health, so you can confirm any "this is broken" verdict in the DataHub UI
  inside ten seconds.

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

On our seeded catalog: **19/20 with DataHub, 5/20 without.** The control arm gets a
capable-assistant prompt asking for specific tables, owners and SQL. It simply has
no context to answer from.

A benchmark scored on a catalog you built yourself is partly built in, so we ran
the same 20 questions against **DataHub's own published `showcase-ecommerce`
datapack**: 1,065 entities over seven platforms, none of them ours, loaded with one
CLI command. Result there was **20/20 versus 3/20**, checking facts the pack
carries. That `ORDER_DETAILS` has David Kim and Julia Novak as its stewards. That
it is kept for a year, charged to Marketing, inside SOC 2 scope. It gives the agent
a harder time than our own catalog does, because it loads alongside ours, so the
search surface holds two `orders` tables, six `order_details`, and an
`ORDER_DETAILS_REPLICA` matching the real table byte for byte across 55 columns.

The decay engine got the same treatment, since a demo where the author planted the
failure proves very little. On that datapack we dropped a column a runbook's SQL
selects, deprecated a table a runbook routes people to, and removed an owner a
runbook tells you to page. All through DataHub's own write APIs. The engine was
told nothing. It caught all three, one finding each, and stayed quiet on the other
seven entities and 43 columns. `npm run validate` exited 2. Both scorecards and the
drill receipts are committed, and CI re-scores every raw answer on each push.

## How we built it

Next.js app + Chrome side-panel extension sharing one backend. The backend
spawns the official `mcp-server-datahub` (with mutations enabled), hands the
LLM the live MCP tool list, and streams every tool call and result to the UI.
Runbook decay detection snapshots the catalog facts each step depends on at
record time, then diffs them against live DataHub on demand. A zero-setup demo
mode answers every MCP call from a built-in fixture of the same catalog our
seed script creates, so judges can run the full product — including the eval
benchmark — with no Docker and a free-tier API key.

The hosted demo needs no API key. A real session is recorded and committed, then
replayed as the same streamed events: the same MCP calls, the same results, the
same text, labelled *recorded session* so nobody mistakes it for live. Paste your
own key and it goes live.

**DataHub technologies used:** DataHub MCP Server (search, get_entities,
get_lineage, get_dataset_queries, list_schema_fields, search_documents,
save_document, add_tags, add_owners / remove_owners, with mutations enabled),
DataHub GraphQL API (`raiseIncident`, `updateIncidentStatus`, `updateDeprecation`,
`createTag` — incidents have no MCP tool), the OpenAPI v3 entity endpoint (schema
rewrites for the decay drill), `datahub datapack load showcase-ecommerce`, DataHub
docker quickstart, and Python SDK ingestion (seed script for the Northbeam demo
catalog: 14 datasets, lineage, glossary, assertions, incidents, saved queries).

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
- **The tool almost ate its own tail.** Raise a native Incident when a runbook
  breaks and the next nightly sweep sees an open incident that wasn't there at
  record time, then reports it as fresh drift. Every night, forever. Deduplicating
  needs the incident's title, and it turns out you cannot read an incident over MCP
  at all. `get_entities` on an incident URN answers "exists but no data could be
  retrieved", and the entity's health summary says `causes: ["ACTIVE_INCIDENTS"]`
  where the assertions branch returns URNs. We dropped to GraphQL and filed it.
- Owner drift was undetectable on live catalogs and nothing said so. Our snapshot
  collected owner URNs while skipping display names, and a runbook step says "ping
  Priya Sharma" rather than "ping urn:li:corpuser:b2fd91.patrick1@example.com".
  Running the drill on a catalog we hadn't authored is what surfaced it.

## Contributing back

Building this turned up work worth sending upstream. All of it is in the repo.

- **A `datahub-onboarding` skill for `datahub-project/datahub-skills`.** The
  onboarding and handoff workflow generalised into a registry skill, with a
  `/catalog-onboarding` command, two evaluation cases and the router registration.
  Written against what `mcp-server-datahub` 0.6.0 exposes.
- **Four friction reports, each with a reproduction.** No MCP tool returns usage
  statistics. Incidents are unreadable over MCP. Two tool schemas use multi-type
  `anyOf` unions that make OpenAI-compatible providers 422 the whole tool list.
  `datapack load showcase-ecommerce` quietly drops 248 MCPs on OSS, every usage and
  assertion aspect among them, while reporting success. We checked each against the
  existing open issues first. Two of them changed this codebase.

## Accomplishments we're proud of

- The full loop closes: knowledge is captured *from* the catalog, written
  *into* the catalog, and invalidated *by* the catalog.
- A measured, reproducible answer to "does DataHub grounding matter?". 19/20
  against 5/20 on our catalog, **20/20 against 3/20 on DataHub's own**, scored
  deterministically, auditable by hand, re-verified by CI on every push.
- The decay engine held up against real breaking changes on a catalog we didn't
  build, and its findings land in DataHub's own Incidents and tags rather than
  stopping at a document.
- The Chrome side panel makes DataHub itself the recording studio — no
  new tool to learn on the worst week to learn one (your last).
- 51 tests, a hosted demo that needs no API key, and every judge-facing claim
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
