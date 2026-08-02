# ⚡ instaboard

[![ci](https://github.com/mcrowley19/Instaboard/actions/workflows/ci.yml/badge.svg)](https://github.com/mcrowley19/Instaboard/actions/workflows/ci.yml)
*CI re-scores the committed benchmark answers on every push. A green badge means you can
reproduce the published **19/20 vs 5/20** on our catalog and **20/20 vs 3/20** on DataHub's
own `showcase-ecommerce` datapack.*

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

![Validating a runbook against live DataHub](docs/media/validate-live.gif)
*Recorded against a live DataHub: one click re-validates Priya's runbook, flags
the failing freshness assertion on step 1, and writes the warning back to the
catalog ("✓ flagged in DataHub"). [The note as it appears inside
DataHub](docs/screenshots/stale-runbook-note-in-datahub.jpg) · [the failing
assertion it detected](docs/screenshots/payment-health-failing-assertion.jpg) ·
[dated receipts](docs/live-verification.md).*

---

## Does grounding in DataHub actually help? We measured it twice.

`evals/` holds a 20-question onboarding benchmark — the questions a real new hire
asks in week 1 — scored **deterministically** against the catalog. Every check is a
substring match on facts that live in DataHub (real URNs, real owners, real columns).
No LLM judge, no partial credit: a case passes only if every one of its checks passes.

The same 20 cases run twice through the **identical agent loop** (`lib/agent.ts`).
The only variable is whether the DataHub MCP tools are in the tool list.

A benchmark you score on your own catalog is partly built in, so it runs on **two**:

| Suite | Catalog | With DataHub | Control | Scorecard |
| --- | --- | --- | --- | --- |
| `northbeam` | seeded by this repo | **19/20** | 5/20 | [scorecard.md](evals/results/scorecard.md) |
| `showcase` | **DataHub's own `showcase-ecommerce` datapack**, 1,065 entities we didn't author | **20/20** | 3/20 | [showcase-scorecard.md](evals/results/showcase-scorecard.md) |

```bash
DEMO_MODE=true npm run eval                # Northbeam, no DataHub, no Docker
npm run eval -- --live --suite=showcase    # DataHub's own catalog
```

One command loads the showcase catalog (`datahub datapack load showcase-ecommerce`), and it
gives the agent a harder time than ours does. It sits alongside Northbeam, so the search
surface has real collisions in it: two `orders` tables, six datasets called some form of
`order_details`, and an `ORDER_DETAILS_REPLICA` whose 55 columns match the real one byte for
byte. The stewards, the escalation contact, the retention period, the SOC 2 scope, the
glossary SQL: all of it came out of the pack. See
[`docs/showcase-verification.md`](docs/showcase-verification.md).

Every raw answer sits in the matching `latest.json`, so you can audit any check by hand.
Two categories are hard to believe from a checkmark, so **hallucination** and
**health-trap** also have their full transcripts committed with both arms side by side, at
[`evals/results/transcripts/`](evals/results/transcripts/).

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
prompts are in `evals/suites.ts`.

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

Both requests the side panel makes are captured against a live catalog and committed at
[`examples/live/extension-receipt.json`](examples/live/extension-receipt.json), covering
entity detection off a real DataHub URL, an answer grounded in 5 MCP calls, and a recorded
runbook written back with its document URN. See
[`docs/extension-verification.md`](docs/extension-verification.md).

## Features

- **🔁 Handoffs** — the headline. Record a task by doing it; the agent turns the
  trail plus your notes into a catalog-grounded runbook, saved locally **and
  written back into DataHub**, linked to the datasets it touches. Replayed
  step-by-step by whoever inherits it.
- **🕰️ Runbook decay detection** — one click re-validates a runbook against live
  DataHub. `npm run validate` sweeps every stored runbook unattended and exits non-zero
  when one is broken, so a cron job runs the decay loop for you. There is no LLM in the
  detection. It diffs the schema and reads health, which means you can confirm any "this
  is broken" verdict in the DataHub UI inside ten seconds. It catches vanished entities,
  **removed columns the runbook's SQL actually references**, tables deprecated since
  recording, new incidents, assertions that started failing, and owners who have moved on.
  Proved against real breaking changes on DataHub's own datapack:
  [see the drill](docs/showcase-verification.md).
- **🚨 Write-back into DataHub's native primitives** — a drift note sits in a document
  until somebody opens it. When a sweep finds a runbook that would now fail if followed,
  it raises a real **Incident** on the affected dataset, typed from the finding and linked
  to the note, and tags everything that drifted **`Stale Runbook`**. The finding turns up
  in the workflows a data team already watches, and "which tables have rotted runbooks?"
  becomes a search query. A nightly sweep re-uses the incident it opened last night.
- **💬 Chat assistant** — plain-English Q&A grounded in DataHub metadata, with every MCP
  call visible in an expandable tool trace. Runs on the hosted demo with no API key at
  all, replaying a committed recording of a real session.
- **🩺 Data health awareness** — reads the `health` and `deprecation` fields DataHub
  inlines on an entity before it recommends a table, then leads with ⚠️ and the safe
  alternative rather than answering confidently from a dead one.
- **📈 Usage-aware ranking** — prefers tables people query over tables that merely exist,
  using whatever the deployment gives it. Usage stats in demo mode. DataHub's own
  `📈 Most Queried` and certification tags on a live catalog, since the MCP server exposes
  no usage tool ([reported upstream](submission/oss/issues/01-no-usage-statistics-tool.md)).
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

1. **Open it. No key, no Docker, no signup.** The hosted demo at
   [instaboard-mu.vercel.app](https://instaboard-mu.vercel.app) answers the suggested
   questions from a committed recording of a real session, streaming back the same tool
   trace, the same MCP calls and results, the same text. Replayed answers carry a
   *recorded session* label so you always know which you are looking at. Paste a key in
   Settings and it goes live. Locally: `npm install`, `echo "DEMO_MODE=true" > .env.local`,
   `npm run dev`.
2. **Watch the headline loop.** Go to `/handoffs`, open the sample runbook, hit **Validate
   against DataHub**. You get a deterministic staleness verdict on step 1, written back to
   the catalog three ways: a drift note carrying the document URN DataHub reports, a native
   Incident on the affected dataset, and a `Stale Runbook` tag. `npm run validate` does the
   same sweep unattended and exits non-zero on a broken runbook, so you can cron it.
3. **Check it on a catalog we didn't build.** See
   [`docs/showcase-verification.md`](docs/showcase-verification.md). Against DataHub's own
   `showcase-ecommerce` datapack the benchmark scores **20/20 vs 3/20**, and a decay drill
   drops a column a runbook selects, deprecates a table a runbook routes people to, and
   moves an owner a runbook tells you to page. All three get caught, one finding each,
   nothing else fires. [Receipts](examples/live/showcase-decay-receipts.json).
   [The incident in DataHub](docs/screenshots/showcase-stale-runbook-tag-and-incident.jpg).
4. **Audit the measurement.** [`scorecard.md`](evals/results/scorecard.md) and
   [`showcase-scorecard.md`](evals/results/showcase-scorecard.md) ship with every raw
   answer, and CI re-scores them on each push. `npm test` runs 51 unit tests.

Against the judging criteria. **Use of DataHub**: reads the MCP tool set, and writes back
through documents (runbooks, decay notes, learning paths, description proposals) as well as
DataHub's own operational primitives, so a finding lands somewhere a data team already
watches. **Originality**: capture, replay and decay make this an onboarding product rather
than another lineage guard, and the Chrome side panel turns DataHub itself into the
recording surface. **Technical execution**: a decay engine with no LLM in it, a two-catalog
benchmark that CI re-verifies, an eval runner that resumes across free-tier quota walls, and
one agent loop shared by the app, the extension and the benchmark. **Real-world
usefulness**: the fortnight around every departure and every new hire, which data platform
teams pay for today. **Open source**: a skill sent upstream plus four friction reports with
reproductions, described under [Contributing back](#contributing-back-upstream).

## Quick start

### Fastest path: demo mode (no DataHub needed)

```bash
npm install
echo "DEMO_MODE=true" > .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click one of the suggested
questions. Those replay a committed recording of a real session, so chat works with no API
key at all. Add a key in **Settings** (Anthropic / OpenRouter / Gemini) to ask anything
else.

The transcript labels recorded answers *recorded session*. What gets replayed is the real
event stream, so the tool trace expands to the same MCP calls and results the live agent
made. `npm run capture:replay` records it again; the events come straight out of
`lib/agent.ts`.

Demo mode answers every DataHub tool call from a built-in fixture of the same
Northbeam catalog the seed script creates — same datasets, owners, lineage,
glossary, health signals, and saved SQL. The full agent loop, tool traces, learning
paths, lineage explainer, handoff replay, and **the eval harness** all work with
zero infrastructure. The sidebar pill shows **Demo catalog** so the mode is never
ambiguous.

**Where the fixture and the real server part company.** The fixture offers 7 tools. Live
`mcp-server-datahub` 0.6.0 offers 20. Two of the fixture's have no equivalent on the real
server: `get_dataset_health` and `get_usage_stats`. DataHub inlines `health` and
`deprecation` on `get_entities` instead, and exposes nothing for usage
([reported upstream](submission/oss/issues/01-no-usage-statistics-tool.md)). A demo-mode
tool trace therefore shows two calls you will never see against a live catalog. The decay
engine reads the inlined `health` first and treats a health tool as an optional extra,
which is how the same code path produced the [live receipts](docs/live-verification.md)
and the [showcase drill](docs/showcase-verification.md) on a real DataHub where neither
tool exists. Both scorecards and the drill ran against live DataHub rather than the
fixture.

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
| `npm test` | vitest suite (45 tests, MCP mocked) |
| `npm run eval` | the 20-case onboarding benchmark, both arms (`-- --suite=showcase` for DataHub's catalog) |
| `npm run eval:verify` | re-score the committed answers for both suites — CI runs this on every push |
| `npm run eval:transcripts` | render the hallucination / health-trap transcripts from committed answers |
| `npm run validate` | sweep every runbook for decay; write notes, incidents and tags back to DataHub |
| `npm run showcase:drill` | `record` / `break` / `receipts` / `restore` — the decay drill on DataHub's own datapack |
| `npm run capture:replay` | record a real session for the zero-key hosted demo |
| `npm run receipts:live` | re-capture the live-DataHub verification receipts |
| `npm run seed` | seed the Northbeam demo catalog into DataHub |
| `npm run datahub:up` / `datahub:down` | start / stop the local DataHub stack |

## Project layout

```
app/            page.tsx (landing) · (app)/ signed-in pages · api/ routes
components/     Sidebar, ToolTrace, Markdown, SettingsModal
lib/            mcp.ts (MCP client) · agent.ts (loop) · decay.ts (validation)
                sweep.ts (the unattended pass) · native-writeback.ts (incidents + tags)
                datahub-graphql.ts (what MCP has no tool for) · replay.ts (zero-key demo)
                providers.ts (LLMs) · prompts.ts · demo-catalog.ts · demo-mcp.ts
evals/          benchmark.ts + benchmark-showcase.ts (20 cases each) · suites.ts
                score.ts · run.ts · verify.ts · transcripts.ts · results/
extension/      Chrome side panel
scripts/        seed_datahub.py · showcase-drill.ts · capture-replay.ts
                validate-runbooks.ts · live-receipts.ts
submission/oss/ the upstream skill PR and the friction reports
tests/          vitest suite
```

## Contributing back upstream

Building this turned up work worth sending back. It is prepared in
[`submission/oss/`](submission/oss/), with instructions in
[`PR_INSTRUCTIONS.md`](submission/oss/PR_INSTRUCTIONS.md).

**A skill for `datahub-project/datahub-skills`.** The onboarding and handoff workflow,
generalised into a registry skill called `datahub-onboarding`, with a
`/catalog-onboarding` command, two evaluation cases and the router registration. It is
written against what `mcp-server-datahub` 0.6.0 exposes, which is why it reads `health` and
`deprecation` off `get_entities` rather than reaching for tools that aren't there.

**Four friction reports with reproductions.** Three go to `acryldata/mcp-server-datahub`,
one to `datahub-project/datahub`.

| Report | What |
| --- | --- |
| [no usage-statistics tool](submission/oss/issues/01-no-usage-statistics-tool.md) | Nothing in the 20-tool surface returns usage and `get_entities` doesn't inline it, so an agent has no way to rank six lookalike tables by query volume |
| [incidents are unreadable](submission/oss/issues/02-incidents-unreadable.md) | `get_entities` on an incident URN errors, and health reports `causes: ["ACTIVE_INCIDENTS"]` where the assertions branch of the same field returns URNs |
| [`anyOf` union schemas](submission/oss/issues/03-anyof-union-schemas-rejected-by-providers.md) | Two tool schemas use multi-type unions that make OpenAI-compatible providers 422 the whole tool list |
| [datapack drops Cloud-only aspects](submission/oss/issues/04-showcase-datapack-drops-cloud-only-aspects.md) | `showcase-ecommerce` loses 248 MCPs on OSS, every usage and assertion aspect among them, and still reports success |

Each one was checked against the existing open issues first. Two of them changed this
codebase. [Report 02](submission/oss/issues/02-incidents-unreadable.md) is why
`lib/datahub-graphql.ts` exists, and why `discountSelfRaisedIncidents` in `lib/decay.ts`
has to be there so the sweep stops reading its own incidents as drift.

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
