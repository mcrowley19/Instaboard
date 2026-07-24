# ⚡ instaboard

**Turn your DataHub catalog into a personal tutor for new data hires.**

When someone joins a data team, they don't know which tables matter, who owns the
pipelines, or how metrics are defined. instaboard is an AI onboarding copilot that
answers those questions from your organization's **live DataHub catalog** — not
generic docs — via the official [DataHub MCP Server](https://github.com/acryldata/mcp-server-datahub).

It ships as two surfaces sharing one backend:

- **Web app (the brain)** — chat, learning paths, lineage explainer, progress, settings
- **Chrome extension (the coach)** — a side panel that follows you *inside* DataHub,
  detects the entity on screen, and answers "explain this table" in place
  ([install instructions](extension/README.md))

> *"What tables do we use for revenue?"* → real dataset names, owners, lineage,
> sample SQL, and URNs, with every DataHub call visible in a collapsible trace.

## Features

- **💬 Chat assistant** — plain-English Q&A grounded in DataHub metadata. The agent
  calls `search`, `get_entities`, `get_lineage`, `get_dataset_queries`, and schema
  tools as needed, and every MCP call is shown in an expandable tool trace.
- **🗺️ Week-1 learning path generator** — pick a role + domain, get a structured
  5-day plan (core tables → metrics & glossary → pipelines & lineage → SQL
  patterns → people to know) built from live catalog exploration, with real URNs.
- **📤 Write-back to DataHub** — one click saves the generated path into DataHub
  via the MCP `save_document` tool, so the *next* hire finds it in the catalog.
- **🔀 Lineage explainer** — search a dataset, get upstream sources, downstream
  consumers, and an "impact if changed" briefing with owners to talk to.
- **✅ Progress tracker** — check off learning-path items as you ramp (localStorage).
- **🧩 Chrome side panel** — context-aware coaching next to DataHub itself: the
  extension captures the URL/URN/selection of the page you're on and offers
  one-click actions ("Explain this table", "Who owns this?", "Show lineage",
  "Common SQL for this"). Thin client — no keys in the extension.
- **🎓 Trainer & trainee modes** — an experienced teammate hits **Record** in the
  side panel and just does a task in DataHub; instaboard captures the trail,
  enriches every step through the DataHub MCP tools (owners, lineage, real SQL),
  and saves the resulting step-by-step walkthrough into the catalog via
  `save_document`. New hires open the **Learn** tab, pick a walkthrough, and
  follow it with live "you're here" detection, auto-checked progress, grounded
  per-step Q&A, and a closing quiz.

## Quick start

### 0. Fastest path: demo mode (no DataHub needed)

Want to see everything working in under a minute? Skip Docker entirely:

```bash
npm install
echo "DEMO_MODE=true" > .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste an LLM key in
**Settings** (Anthropic / OpenRouter / Gemini), and ask *"How do we calculate
MRR?"*. Demo mode answers every DataHub tool call from a built-in fixture of
the same Northbeam catalog the seed script creates — same datasets, owners,
lineage, glossary, and saved SQL — so the full agent loop, tool traces,
learning paths, and lineage explainer all work with zero infrastructure.
The sidebar pill shows **Demo catalog** so you always know which mode you're in.

For the real thing against a live DataHub, continue below.

### 1. Install

```bash
npm install
```

You'll also need [uv](https://docs.astral.sh/uv/getting-started/installation/)
(`curl -LsSf https://astral.sh/uv/install.sh | sh`) — it runs the DataHub MCP
server and the seed script; no manual Python setup required.

### 2. Run DataHub locally (Docker)

```bash
npm run datahub:up        # wraps: datahub docker quickstart
```

This starts the full DataHub stack (GMS on `:8080`, UI on `:9002`). First run
downloads several images — give it a few minutes. Docs:
[DataHub quickstart](https://docs.datahub.com/docs/quickstart).

### 3. Seed the demo catalog

```bash
npm run seed
```

Seeds **Northbeam**, a fictional subscription-commerce company: 14 datasets across
postgres + snowflake with full schemas and docs, 4 owners, 3 domains, PII/Tier1/
Finance tags, a metrics glossary (MRR, ARR, Churn Rate, GMV, Active User),
lineage across 4 pipelines, and 5 saved SQL queries. Verify at
[http://localhost:9002](http://localhost:9002) (login `datahub` / `datahub`).

### 4. Configure environment

```bash
cp .env.example .env.local
```

The defaults work for a local quickstart. If your DataHub requires auth, set
`DATAHUB_GMS_TOKEN` to a personal access token.

### 5. Add an LLM API key

No keys are hardcoded — bring your own, either way:

- **In the app (recommended):** click **Settings** in the sidebar and paste a key
  for Anthropic (Claude), OpenRouter, or Google Gemini. Stored only in your
  browser's localStorage and sent to your own server per-request.
- **Or in `.env.local`:** set `LLM_PROVIDER` and `LLM_API_KEY`.

### 6. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and ask:
*“How do we calculate MRR?”*

## Try these

| Ask | What happens |
| --- | --- |
| What tables do we use for revenue? | `search` → `get_entities` → cites `fct_revenue`, `mrr_monthly` with owners & URNs |
| Who owns the payments pipeline? | fetches entities and reports actual owners (Priya Patel et al.) |
| How is customer_id defined? | schema-field lookup across `dim_customers` and sources |
| Show me SQL for churn analysis | `get_dataset_queries` returns the real saved query on `fct_churn` |
| What breaks if I change users.email? | `get_lineage` downstream walk → impacted marts + who to warn |

## Architecture

```
┌──────────────────────────────┐   ┌────────────────────────────────┐
│  Next.js UI (light, streamed)│   │  Chrome extension (side panel) │
│  chat · path · lineage ·     │   │  context capture on DataHub ·  │
│  progress                    │   │  quick actions · same chat     │
└──────────────┬───────────────┘   └───────────────┬────────────────┘
               │ fetch (NDJSON event stream)       │ fetch + {message, context}
┌──────────────▼───────────────────────────────────▼───────┐
│  API routes (app/api/*)                                  │
│  /chat · /learning-path · /lineage · /save-document ·    │
│  /health — CORS-enabled for the extension                │
│  ┌────────────────────────┐                              │
│  │ Agent loop (lib/agent) │  LLM ⇄ tools until answered  │
│  └───┬───────────────┬────┘                              │
│  LLM providers   MCP client (singleton, stdio)           │
│  (Claude / OpenRouter / Gemini — keys server-side only)  │
└──────────────────────┼───────────────────────────────────┘
                       │ spawns: uvx mcp-server-datahub
            ┌──────────▼──────────┐
            │  DataHub MCP Server │  search · get_entities · get_lineage ·
            └──────────┬──────────┘  get_dataset_queries · save_document …
                       │ GraphQL/REST
            ┌──────────▼──────────┐
            │  DataHub GMS :8080  │  (docker quickstart)
            └─────────────────────┘
```

- The MCP server is spawned once per server process (`uvx mcp-server-datahub`)
  with `TOOLS_IS_MUTATION_ENABLED=true` so `save_document` write-back works.
- The agent loop hands the LLM the **live** MCP tool list, executes every tool
  call against DataHub, and streams `tool_call` / `tool_result` / `text` events
  to the UI — which is what renders the collapsible trace.
- Learning paths are generated as structured JSON from real catalog exploration,
  rendered as a checklist, and written back with `save_document`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | start the app on :3000 |
| `npm run build` / `npm start` | production build / serve |
| `npm test` | vitest smoke tests (MCP mocked — runtime always hits real DataHub) |
| `npm run seed` | seed the Northbeam demo catalog into DataHub |
| `npm run datahub:up` / `datahub:down` | start / stop the local DataHub stack |

## Project layout

```
app/            pages (chat, path, lineage, progress) + API routes
components/     Sidebar, ToolTrace, Markdown, SettingsModal
lib/            mcp.ts (MCP client) · agent.ts (loop) · providers.ts (LLMs) · prompts.ts
scripts/        seed_datahub.py — demo catalog ingestion
tests/          vitest smoke tests
examples/       sample generated learning path, SQL snippets, saved document
```

## Security notes

- `.env`, `.env.local`, `*.key`, and `credentials.json` are gitignored; the repo
  ships only `.env.example` with placeholders.
- API keys pasted in the UI live in browser localStorage and are forwarded as
  request headers to *your own* Next.js server only.

## Troubleshooting

- **Sidebar says "DataHub offline"** — GMS isn't reachable. Check
  `docker ps`, then `curl http://localhost:8080/health`. The status pill polls
  every 30s.
- **"No LLM configured"** — add a key in Settings or `.env.local`.
- **Learning path comes back empty** — the catalog probably has no data for that
  domain. Run `npm run seed` and try domain "Payments".
- **First MCP call is slow** — `uvx` resolves `mcp-server-datahub` on first use;
  subsequent calls are warm.
