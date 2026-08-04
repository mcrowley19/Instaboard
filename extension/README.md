# instaboard Chrome extension

A Manifest V3 side panel that coaches new hires **while they browse DataHub**.
It runs as a thin client, so every LLM call, MCP call and secret stays on the
instaboard backend, and the extension holds **no API keys**.

## Install (unpacked)

1. Start the backend: `npm run dev` in the repo root (and have DataHub running + seeded).
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the instaboard icon and click it. The side panel opens.

If your backend isn't on `http://localhost:3000`, click the ⚙ icon in the
panel and set the URL (stored in `chrome.storage.local`).

> The backend must have `LLM_PROVIDER` / `LLM_API_KEY` set in `.env.local`.
> Keys pasted in the web app's Settings live in that browser tab's
> localStorage, where the extension cannot see them.

## How it works

- `background.js` opens the side panel when the toolbar icon is clicked.
- `content.js` runs on DataHub pages (`localhost:9002`, `*.acryl.io`,
  `*.datahubproject.io`) and extracts the entity URN from the URL, the page
  title, and any selected text.
- `sidepanel.js` is the chat UI. On every message it captures the current tab's
  context and POSTs to `/api/chat`:

```json
{
  "message": "Explain this table",
  "messages": [ /* prior turns */ ],
  "context": {
    "url": "http://localhost:9002/dataset/urn%3Ali%3Adataset%3A(...)/Schema",
    "title": "fct_revenue | DataHub",
    "datasetUrn": "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)",
    "entityType": "dataset",
    "selection": "net_amount_usd"
  }
}
```

The backend folds that context into the agent's system prompt, so
"explain **this** table" resolves to the dataset on screen, and the agent
still fetches live details through the DataHub MCP server before answering.
Tool calls stream back and render as collapsible traces, exactly like the
web app.

## Quick actions

When a DataHub entity is detected (blue context bar shows the dataset name):

- **Explain this table**
- **Who owns this?**
- **Show lineage**
- **Common SQL for this**

Buttons are disabled on non-DataHub pages.

## Handoffs: record → inherit

**Leaving? Record your task.** Hit **● Record** in the panel header, then do the
task in your DataHub tab. Every page you visit is captured as a step, carrying
the URL, title and entity URN. Type a note on each page, the "why" your successor
can't google, and press *Add note*. Hit **■ Stop**, give the task a title and
your name, and click *Generate runbook & save to DataHub*. The backend looks
up every entity you touched, so owners, schemas, real saved queries and lineage,
merges in your notes, and produces a step-by-step runbook that is:

- stored on the backend (`GET /api/handoffs`), and
- **written back into DataHub** via the MCP `save_document` tool, linked to
  the datasets it references, so it's discoverable in the catalog itself.

**Joining? Inherit it.** Open the **Handoffs** tab, pick a task, and replay it.
Each step shows what to do, why, real SQL, and gotchas. *Open this page ↗*
navigates your DataHub tab to the right entity, a **📍 You're on this page**
pill confirms when your current tab matches the step, and *Ask the coach* jumps
to chat pre-loaded with the step's context. Progress is saved per handoff.

`POST /api/handoffs` request body:

```json
{
  "title": "Monthly MRR report for the board deck",
  "author": "Priya Patel",
  "role": "Payments Data Lead",
  "steps": [
    { "url": "http://localhost:9002/dataset/…", "title": "fct_revenue | DataHub",
      "urn": "urn:li:dataset:(…)", "note": "net_amount_usd, never gross." }
  ]
}
```

The response streams NDJSON: `tool_call` / `tool_result` events while the
agent explores the catalog, then `{"type": "result", "data": <handoff>}`.
