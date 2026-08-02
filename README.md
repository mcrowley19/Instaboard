# ⚡ instaboard

[![ci](https://github.com/mcrowley19/Instaboard/actions/workflows/ci.yml/badge.svg)](https://github.com/mcrowley19/Instaboard/actions/workflows/ci.yml)

**Captured knowledge that tells you when it has gone wrong.**

A runbook is written once and read for years. The catalog underneath it does not
hold still: a column gets renamed, a table gets deprecated, the person named in
step 2 moves teams. The runbook goes on reading exactly as confidently as it did
on the day it was written, and the next person follows it into a wall.

instaboard captures a data workflow into DataHub, and then keeps checking whether
the catalog still agrees with it. When it stops agreeing, that shows up as state
on the affected datasets — a failing assertion, an incident assigned to whoever
owns the data now — and as a proposed correction for a human to approve.

That is the claim. One command proves it end to end.

```bash
npm run prove
```

Starts DataHub if it isn't up, ingests a sample catalog, captures a runbook
against it, validates it clean — then **renames a column the runbook's SQL
selects, deprecates a table it routes you to, and moves the owner it tells you to
page**, through DataHub's own write APIs, and checks that revalidation catches all
three. Then it restores the catalog and checks the runbook goes green again.

**29 assertions. Non-zero exit if any fails. Last run: 29/29 — on both catalogs.**

```bash
npm run prove                        # the catalog this repo seeds
npm run prove -- --catalog=showcase  # DataHub's own showcase-ecommerce datapack
```

```
4/7  validate — should be clean
    ✓ no drift reported — 1 runbook checked, 0 drifted
    ✓ every catalog claim holds — 17/17 claims hold
5/7  break the catalog for real
    ✓ renamed net_amount_usd → net_revenue_usd on fct_revenue
    ✓ deprecated mrr_monthly
    ✓ removed Mike Rodriguez from fct_revenue
6/7  revalidate — should catch all of it
    ✓ the runbook is reported broken — 1 broken of 1
    ✓ broken claims moved the aspect they were pinned to — 3 of 17 broken, 14 still hold
    ✓ an incident is raised and assigned to the current owner — 88bdde80effa → urn:li:corpuser:priya.patel
    ✓ a correction is proposed for the renamed column — net_amount_usd→net_revenue_usd
7/7  restore the catalog and revalidate — should go green again
    ✓ every catalog claim holds — 17/17 claims hold
```

The decay engine is told nothing about the breaking changes. It re-reads the
catalog and works out what happened. Receipts for both runs:
[northbeam](examples/live/prove-loop-receipts.json),
[showcase-ecommerce](examples/live/prove-loop-receipts-showcase.json), walked
through in [`docs/loop-verification.md`](docs/loop-verification.md). CI re-verifies
both on every push, so a stale or partial capture fails the build.

Running it on DataHub's datapack immediately earned its keep: it caught a real
weakness in the rename detector (a full token reorder,
`cost_of_delivery` → `delivery_cost_usd`, scored 0.06 on edit distance and fell
below the threshold) and one over-strict assertion of our own. Both fixed.

![Validating a runbook against live DataHub](docs/media/validate-live.gif)

*Recorded against a live DataHub: one click re-validates a runbook, flags the
failing freshness assertion on step 1, and writes the warning back to the catalog.
[The note inside DataHub](docs/screenshots/stale-runbook-note-in-datahub.jpg) ·
[the failing assertion it detected](docs/screenshots/payment-health-failing-assertion.jpg) ·
[the incident and tag it raised](docs/screenshots/showcase-stale-runbook-tag-and-incident.jpg) ·
[dated receipts](docs/live-verification.md).*

---

## How the loop works

**0. Draft, before anyone records anything.** A year-old catalog already holds
the queries people ran, the lineage of what feeds what, who owns which table and
what has been failing. `npm run draft -- --query=revenue` reads that and produces
a first pass — health check, upstream checks, the recorded SQL, downstream blast
radius — so the tool is useful on day one in any DataHub, and the person leaving
corrects a draft instead of facing a blank page.

What a catalog cannot supply is *why step 2 exists*. So drafted steps are marked
`inferred`, their reasons read as evidence rather than as remembered intent, and
every surface that renders one says **"Draft runbook — nobody recorded this"**. A
draft that impersonated a colleague's judgement would defeat the point of the
project. [Sample](examples/drafts/).

**1. Capture.** Someone leaving hits ● Record and just does the task in DataHub.
Every page becomes a step; they annotate the *why*. The agent enriches each step
from the live catalog — owners, real recorded SQL, lineage, health — and writes
the runbook back with `save_document`, linked to the datasets it touches. Five
real ones are in [`examples/runbooks/`](examples/runbooks/).

**2. Pin.** Each step is decomposed into **claims**: *this dataset exists*, *it has
a column called `net_amount_usd`*, *Mike owns it*. Each claim is pinned to a
content fingerprint of the exact catalog aspect that backed it. The fingerprints
hash public catalog facts, so anyone holding the runbook and a DataHub connection
can recompute one and check the pin.

**3. Validate.** Re-read the catalog and re-check every claim. Detection is a
deterministic schema-and-health diff — **no LLM anywhere in it** — so a verdict is
something you can confirm in the DataHub UI in ten seconds:

```
✓ step 2 · fct_revenue has a column `net_amount_usd`, which this step reads. — schema@89280579c9b0 (2026-07-01) → schema@89280579c9b0
✗ step 1 · payment_health_daily has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-07-01) → health@b3b7361fb1ae
```

The report says `18 of 19 claims still hold`, which tells a reader the runbook is
followable apart from one named thing. "Stale" does not.

**4. Write it back as state.** Not just prose in a document nobody opens:

- a **custom assertion** per (runbook, dataset) that fails while the runbook is
  stale and passes when it validates clean, carrying the specific catalog change
  and the provenance chain in its result properties;
- **structured properties** with the runbook's status, the change that broke it,
  and every validated-against pin;
- a **`Stale Runbook` tag** on everything that drifted;
- a real **Incident** on any dataset where a step would now fail — **assigned to
  whoever owns that dataset today**, which in the owner-drift case is precisely
  the person the runbook has never heard of.

Clean runs are written too. A dataset only written to when something breaks can't
distinguish "fine" from "nobody checked".

**5. Propose the fix.** `npm run propose` derives the correction from the catalog
— the renamed column matched against columns that appeared since, the replacement
named in a deprecation note, the current owner — and emits a **unified diff for a
human to approve**, with the evidence behind every edit and an explicit list of
what it refused to guess at. `--apply` accepts it; `--pr` opens a pull request.
[Worked example](examples/proposals/monthly-revenue-close.md).

Nothing is applied automatically. A document whose whole value is that a colleague
vouched for it does not get rewritten by a cron job.

`npm run validate` runs steps 3–5 over every stored runbook and exits non-zero on
a broken one, so it works as a cron job or a CI gate.

---

## How good is the detector? Precision and recall on injected drift.

The proof loop breaks three things and catches three things. That is a
demonstration with N=1 per kind, and it only measures recall — it says nothing
about how often the engine fires when nothing is wrong, which is the number that
decides whether a team keeps it switched on.

```bash
npm run bench:drift
```

plants known drifts across every stored runbook, mixed with **decoys** — real
catalog changes that no runbook depends on and that must produce nothing — then
validates blind and scores both.

| | Result |
| --- | --- |
| Planted drifts detected | **6/6** across 3 kinds (column dropped, column renamed, deprecated) |
| Decoys that produced a finding | **0 of 6** |
| Unexplained findings | **0** |
| Precision · recall · F1 | **100% · 100% · 100%** |
| Catalog changes restored afterwards | 12/12 |

[Full run](examples/live/drift-benchmark.json). Three things make that number
mean something rather than flatter us:

- **A baseline pass.** Findings that pre-date the injection are excluded from the
  false-positive count, so a runbook that was already stale isn't blamed on the
  engine — and isn't quietly used to pad it either.
- **Independent ground truth.** Which columns a step "really" reads is derived by
  tokenising its SQL, not by asking the engine's own reference matcher. Otherwise
  recall would be the harness agreeing with itself.
- **Decoys on datasets runbooks actually read.** Two of the six drop a column
  from a table a runbook uses, where no step mentions that column. The engine
  holds a snapshot of those entities and has to stay quiet anyway. Decoys on
  unrelated tables are nearly free to pass; these are not.

Recall is counted per planted drift and precision per finding, on purpose: one
drift legitimately produces several findings when two runbooks read the same
table, and both are right.

## Does grounding in DataHub actually help? Three arms, two catalogs.

`evals/` holds a 20-question onboarding benchmark — the questions a real new hire
asks in week 1 — scored **deterministically** against the catalog. Every check is
a substring match on facts that live in DataHub. No LLM judge, no partial credit.

The obvious two-arm design (with tools, without tools) partly measures *having
tools* rather than *having DataHub*. So there is a third arm in the middle: the
same agent loop connected to the warehouse the way an engineer connects without a
catalog. `information_schema` — table names, column names, column types, nothing
else. It reads the same catalog, stripped to what a database connection would
return.

| Suite | Catalog | With DataHub | **Warehouse schema only** | No tools | Scorecard |
| --- | --- | --- | --- | --- | --- |
| `northbeam` | seeded by this repo | **19/20** | 9/20 | 5/20 | [scorecard.md](evals/results/scorecard.md) |
| `showcase` | **DataHub's own `showcase-ecommerce` datapack**, 1,065 entities we didn't author | **20/20** | 4/20 | 3/20 | [showcase-scorecard.md](evals/results/showcase-scorecard.md) |

On DataHub's own catalog, warehouse introspection scores **one case above
answering from memory**. It is not that it tried less hard: it made 118 tool calls
to the grounded arm's 78 and finished 16 cases behind. Listing every table in the
warehouse does not tell you which of six identically-named copies people actually
use, who to ask about it, or what the company means by "active user".

That is the finding the third arm exists to isolate: **the gap is the metadata,
not the tooling.**

```bash
npm run eval -- --live                     # Northbeam, against your DataHub
npm run eval -- --live --suite=showcase    # DataHub's own catalog
DEMO_MODE=true npm run eval                # no DataHub, no Docker
```

Every raw answer sits in the matching `latest.json`, and CI re-scores all three
arms from those answers on every push. Hallucination and health-trap cases also
have their full transcripts committed with the arms side by side, at
[`evals/results/transcripts/`](evals/results/transcripts/).

---

## What we haven't proven

Everything above is a real run. These are the places where a reader should
discount us, and we would rather name them than have them found.

**The proof loop is one machine, one version, and not a pass rate.** `npm run
prove` has passed 29/29 repeatedly during development on both catalogs, always on
the same macOS laptop against DataHub 1.5.0.6 from the OSS quickstart. It has
never run on DataHub Cloud, never on another DataHub version, and never in CI —
CI re-verifies the committed receipts, which is a weaker check.

**The drift benchmark is still small, and does not cover every kind.** Six
planted drifts and six decoys is enough to catch a broken detector, not enough to
put a confidence interval on 100%. The last run covered three of the four drift
kinds: no `owner-removed` drift was planted, because the planner only plants one
when a step names an owner whose username tokens appear in its prose, and none of
the stored runbooks happened to qualify. So the owner path is proved by the proof
loop (twice, on both catalogs) and not by the benchmark. Both numbers come from
one run on one catalog family; neither is a distribution.

**The decay engine checks five kinds of claim, and misses the worst kind.** It
catches an entity that vanished, a referenced column that vanished, a table
deprecated since recording, health that has turned red, and an owner who moved on.
It cannot see **semantic drift** — a column that still exists and still loads but
now means something different, because an upstream filter changed or the units
moved from cents to dollars. That is the most dangerous form of staleness and we
detect none of it. A runbook can be 19/19 claims holding and still wrong.

**Column detection is text matching, not SQL parsing.** A step "depends on" a
column if the column's name appears, word-boundary matched, in its prose or SQL.
So a column called `date`, `plan` or `status` can match a sentence that is not
about it, and a column reached through `SELECT *` or an alias is invisible. The
first produces a spurious claim; the second produces a missing one.

**Rename detection is string similarity, and the weakest rule we ship.** It scores
candidates at `0.75 × token overlap + 0.25 × edit distance`, treats "every content
word survived" as a strong signal, proposes above 0.55, and refuses when the top
two are within 0.1 of each other. A coincidentally similar name would be proposed
just as readily as a real rename, and a genuine rename to something unrelated
(`net_amount_usd` → `settled_value`) will not be found at all — it lands in the
"needs a person" list, which is the right failure but still a miss. The human
reviewing the diff is the actual check here, not the score.

This rule has already been wrong once in a way we only found by running on a
catalog we didn't build: the original weighting scored
`cost_of_delivery` → `delivery_cost_usd` at 0.49 and missed it, because edit
distance punishes reordering far harder than a reader would. Assume there are
more cases like that one.

**Drafted runbooks are a starting point, not knowledge.** Everything a draft
contains is derived from catalog evidence, and the reason a step exists is not in
any catalog. A draft is worth having because correcting one is much cheaper than
writing from nothing — but a team that files drafts without correcting them has
automated the production of plausible documents, which is worse than having none.
The labelling is deliberate and load-bearing.

**Owner matching can collide.** Owners are matched by normalised substring, so two
people whose display names share a substring could be confused. We have not hit it
on a real catalog; a large org with common surnames would.

**Benchmark numbers are one model, one run per case.** All of it is
`nvidia/nemotron-3-ultra-550b-a55b:free`. We have not measured variance across
re-runs or across models, and the scores would move with either. Cases are cached
so a run can resume, which means a published score may have been assembled across
sessions — always on that one model, never mixed. Six showcase cases hit free-tier
HTTP failures on the first pass and were retried until they returned an answer;
that is retrying transport, not retrying until we liked the result, but it is a
retry policy and you should know it exists.

**Scale is untested.** The largest catalog we have run against is roughly 1,150
entities. The sweep is serial per runbook and does one entity read per URN. We
make no claim about a catalog with 100,000 entities, and the structured-property
merge reads before it writes, which would get expensive.

**The write-back has no permissions model.** It uses whatever token you configure.
There is no RBAC awareness, no notion of who triggered a sweep, and no guard
against two sweeps running at once over the same runbook.

**Custom assertions can't be cleaned up.** `deleteAssertion` refuses the CUSTOM
assertions that `upsertCustomAssertion` creates
([filed upstream](https://github.com/datahub-project/datahub/issues/18817)), so
deleting a runbook leaves its assertion behind on the dataset until someone
removes it with the CLI.

**The Chrome extension is unit-tested, not browser-tested.** Entity detection is
tested against URLs captured from a running DataHub, and there is one real
end-to-end [capture](examples/live/extension-receipt.json). The panel itself is
exercised by hand. We shipped a detection bug that no test caught because no
test drove a real browser — see the upstream issue below.

## When you shouldn't use this

- **Your runbooks aren't about catalogued data.** The whole mechanism is
  re-checking claims against a catalog. A runbook about a deploy process has no
  claims this can verify.
- **Your catalog is thin.** If datasets have no owners, no glossary terms and no
  health signals, there is little for a claim to be pinned to — and the benchmark
  above says most of the value was in exactly that metadata.
- **You need semantic correctness.** See above. This proves a runbook is still
  *executable*, not that it is still *right*.
- **You want fully automatic remediation.** By design it stops at a proposal.

---

## Contributing back upstream

Seven contributions came out of building this, all filed. Write-ups stay in
[`submission/oss/`](submission/oss/) so the reproductions are readable here too.

| What | Where |
| --- | --- |
| **`datahub-onboarding` skill** — the onboarding, capture and validation workflow generalised into a registry skill, with a `/catalog-onboarding` command, three evaluation cases and the router registration | [datahub-skills#79](https://github.com/datahub-project/datahub-skills/pull/79) |
| ↳ follow-up: claim-level provenance, write-back as catalog state, and catalog-derived corrections | [same PR](https://github.com/datahub-project/datahub-skills/pull/79#issuecomment-5159658074) |
| Nothing in the 20-tool MCP surface returns usage, and `get_entities` doesn't inline it, so an agent cannot rank six lookalike tables by query volume | [mcp-server-datahub#171](https://github.com/acryldata/mcp-server-datahub/issues/171) |
| `get_entities` on an incident URN errors, and health reports `causes: ["ACTIVE_INCIDENTS"]` where the assertions branch of the same field returns URNs | [mcp-server-datahub#172](https://github.com/acryldata/mcp-server-datahub/issues/172) |
| Two tool schemas use multi-type `anyOf` unions that make OpenAI-compatible providers 422 the whole tool list | [mcp-server-datahub#173](https://github.com/acryldata/mcp-server-datahub/issues/173) |
| `showcase-ecommerce` silently loses 248 MCPs on OSS, every usage and assertion aspect among them, and still reports success | [datahub#18815](https://github.com/datahub-project/datahub/issues/18815) |
| `deleteAssertion` rejects CUSTOM assertions that `upsertCustomAssertion` created two calls earlier; only the CLI can remove them | [datahub#18817](https://github.com/datahub-project/datahub/issues/18817) |
| **No supported way for a browser integration to know which entity a DataHub page is showing** — with a reference implementation and 16 test vectors | [datahub#18818](https://github.com/datahub-project/datahub/issues/18818) |

The last one is the reusable one. DataHub serves a `dataFlow` at `/pipelines/` and
a `dataJob` at `/tasks/`; 11 of its 31 routes don't match their entity type name and
five are a different word entirely, the mapping is published nowhere, and nothing on the page states the current entity. We
shipped the obvious-and-wrong version and never noticed, because "no entity
detected" is indistinguishable from "not a DataHub page"; we found it by pulling
the route table out of the frontend bundle to check. The fix, the route
table read off a running DataHub, and the vectors are in
[`submission/oss/entity-detection/`](submission/oss/entity-detection/) under MIT — a
test fails the build if our copy and the published copy drift.

One more thing we hit was already filed: the `datapack --help` crash
([datahub#18497](https://github.com/datahub-project/datahub/issues/18497)) got a
[comment confirming it still reproduces on 1.6.0.17](https://github.com/datahub-project/datahub/issues/18497#issuecomment-5159253562)
rather than a duplicate.

Two of them changed this codebase.
[#172](https://github.com/acryldata/mcp-server-datahub/issues/172) is why
`lib/datahub-graphql.ts` exists and why `discountSelfWrittenState` in `lib/decay.ts`
has to stop the sweep reading its own incidents and assertions as drift.

---

## Quick start

### Against a real DataHub

Everything above was produced this way, so it is the path worth taking.

```bash
npm install
npm run datahub:up      # datahub docker quickstart — GMS :8080, UI :9002
npm run seed            # 14 datasets, 4 owners, glossary, lineage, saved SQL
npm run prove           # the whole loop, 29 assertions
npm run dev             # the app on :3000
```

<details>
<summary>Detail: prerequisites, auth, keys</summary>

**Prerequisites** — Node 22, Docker, and [uv](https://docs.astral.sh/uv/getting-started/installation/)
(`curl -LsSf https://astral.sh/uv/install.sh | sh`), which runs the DataHub MCP
server and the seed script. First `datahub:up` pulls several images.

**The seeded catalog** is **Northbeam**, a fictional subscription-commerce company:
14 datasets across postgres and snowflake with full schemas and docs, 4 owners,
3 domains, PII/Tier1/Finance tags, a metrics glossary, lineage across 4 pipelines,
5 saved SQL queries, plus a deliberately failing freshness assertion. Verify at
[localhost:9002](http://localhost:9002) (`datahub` / `datahub`).

**Config** — `cp .env.example .env.local`. Defaults match a local quickstart; set
`DATAHUB_GMS_TOKEN` if your DataHub requires auth.

**LLM key** — in **Settings** in the app (browser localStorage, forwarded to your
own server per request) or `LLM_PROVIDER` / `LLM_API_KEY` in `.env.local`. Nothing
is hardcoded or committed. The benchmark runs on a free tier:

```bash
LLM_PROVIDER=openrouter  LLM_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
LLM_PROVIDER=gemini      LLM_MODEL=gemini-2.5-flash
```

**Chrome side panel** — [install instructions](extension/README.md). It follows you
inside DataHub, detects the entity on screen, and records runbooks. One real
capture against a live catalog is committed at
[`examples/live/extension-receipt.json`](examples/live/extension-receipt.json).

</details>

### Without Docker

```bash
npm install && echo "DEMO_MODE=true" > .env.local && npm run dev
```

Demo mode answers every DataHub tool call from a fixture of the same Northbeam
catalog, and the hosted demo at
[instaboard-mu.vercel.app](https://instaboard-mu.vercel.app) replays a committed
recording of a real session, so chat works with **no API key at all**. Replayed
answers are labelled *recorded session*.

It is a fixture, so treat it as a tour rather than evidence. Two of its 7 tools
(`get_dataset_health`, `get_usage_stats`) have no equivalent on the real 20-tool
server — DataHub inlines `health` and `deprecation` on `get_entities` and exposes
nothing for usage — so a demo tool trace shows two calls you will never see live.
Every number in this README came from a live run, not from here. The write-back
refuses to run in demo mode even if a real GMS is reachable, so a tour can't put
fixture-derived claims onto anyone's datasets.

---

## Also in the box

The decay loop is the claim. These exist because the same agent loop and catalog
reads were already there, and a new hire needs them on day one:

- **Chat** grounded in DataHub metadata, with every MCP call in an expandable tool
  trace
- **Week-1 learning path** for a role and domain, built from live catalog
  exploration, deprecated tables excluded, written back to DataHub
- **Lineage explainer** with an "impact if changed" briefing and who to talk to
- **Health and deprecation guardrails** — reads `health` and `deprecation` before
  recommending a table, then leads with the safe alternative
- **Documentation gap write-back** — drafts a missing description from schema and
  lineage and files it as a `DescriptionProposal` for an owner to review
- **Progress tracker** for the person being onboarded

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run prove` | **the whole loop end to end, 29 assertions** (`-- --catalog=showcase` for DataHub's datapack) |
| `npm run draft` | draft runbooks from catalog evidence, no recording needed (`--query=`, `--urn=`, `--save`) |
| `npm run bench:drift` | plant known drift + decoys, score the detector's precision and recall |
| `npm run validate` | sweep every runbook for decay; write notes, assertions, properties, incidents and tags back |
| `npm run propose` | derive corrections as reviewable diffs (`--apply`, `--pr`) |
| `npm run examples` | export stored runbooks to `examples/runbooks/` |
| `npm test` | vitest suite (181 tests, MCP and GMS mocked) |
| `npm run eval` | the 20-case benchmark, all three arms (`-- --suite=showcase`) |
| `npm run eval:verify` | re-score the committed answers for both suites — CI runs this |
| `npm run showcase:drill` | `record` / `break` / `receipts` / `restore` on DataHub's own datapack |
| `npm run dev` / `build` / `start` | the app |
| `npm run seed` · `datahub:up` · `datahub:down` | the local catalog and stack |

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
│  /chat · /learning-path · /lineage · /handoffs ·          │
│  /handoffs/[id]/verify · /save-document · /health         │
│  ┌────────────────────────┐  ┌─────────────────────────┐ │
│  │ Agent loop (lib/agent) │  │ Decay engine (lib/decay)│ │
│  │ LLM ⇄ tools until done │  │ deterministic diff      │ │
│  └───┬────────────────────┘  └───────────┬─────────────┘ │
│  LLM providers (retry/backoff)   MCP client (singleton)   │
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

- **The decay engine deliberately does not use an LLM.** Detection is a schema diff
  plus a health read against fingerprints captured at record time, so every finding
  is checkable by hand.
- The MCP server is spawned once per process with `TOOLS_IS_MUTATION_ENABLED=true`
  so write-back works. Incidents, assertions and structured properties go over
  GraphQL, because the MCP server has no tools for them.
- The agent loop hands the LLM the **live** MCP tool list and streams
  `tool_call` / `tool_result` / `text` events. The benchmark's three arms all run
  through it.

## Project layout

```
app/            page.tsx (landing) · (app)/ signed-in pages · api/ routes
components/     Sidebar, ToolTrace, Markdown, SettingsModal
lib/            mcp.ts (MCP client) · agent.ts (loop) · decay.ts (validation)
                provenance.ts (claims, fingerprints, pins) · remediate.ts (corrections + diff)
                sweep.ts (the unattended pass) · native-writeback.ts (incidents + tags)
                structured-state.ts (assertions + structured properties)
                draft-runbook.ts (drafting from evidence) · drift-injection.ts (the drift benchmark)
                warehouse-introspection.ts (the eval's third arm)
                datahub-graphql.ts (what MCP has no tool for) · gms-aspects.ts (drill writes)
                replay.ts (zero-key demo) · providers.ts · prompts.ts · demo-*.ts
evals/          benchmark.ts + benchmark-showcase.ts (20 cases each) · suites.ts
                score.ts · run.ts · verify.ts · transcripts.ts · results/
extension/      Chrome side panel · entity-from-url.js (the detection contract)
scripts/        prove-loop.ts (the one-command proof) · drift-benchmark.ts
                draft-runbooks.ts · seed_datahub.py · showcase-drill.ts
                validate-runbooks.ts · propose-fixes.ts · export-examples.ts
                capture-replay.ts · live-receipts.ts
examples/       runbooks/ (five real ones + validation reports) · drafts/ · proposals/
                live/ (dated receipts from live runs, both catalogs)
submission/oss/ the upstream skill PR, the friction reports, the entity-detection package
tests/          vitest suite (181 tests)
```

## Security notes

- `.env*`, `*.key` and `credentials.json` are gitignored; the repo ships only
  `.env.example` with placeholders.
- API keys pasted in the UI live in browser localStorage and are forwarded as
  request headers to *your own* Next.js server only. Nothing is sent anywhere else.
- Write-back requires a DataHub token with mutation rights. See the limitations
  above: there is no permissions model beyond whatever that token can do.

## Troubleshooting

- **Sidebar says "DataHub offline"** — GMS isn't reachable. Check `docker ps`, then
  `curl http://localhost:8080/health`. The status pill polls every 30s.
- **"No LLM configured"** — add a key in Settings or `.env.local`.
- **`npm run eval` exits immediately** — it needs `LLM_PROVIDER` and `LLM_API_KEY`
  in `.env.local`; the UI's localStorage key isn't visible to the CLI.
- **`npm run prove` fails at phase 1** — Docker isn't running, or the quickstart is
  still starting. Pass `--skip-quickstart` once GMS answers.
- **First MCP call is slow** — `uvx` resolves `mcp-server-datahub` on first use.

## License

[Apache 2.0](LICENSE).
