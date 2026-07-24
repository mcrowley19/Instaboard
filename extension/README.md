# instaboard Chrome extension

A Manifest V3 side panel that coaches new hires **while they browse DataHub**.
It is a thin client: every LLM call, MCP call, and secret stays on the
instaboard backend — the extension holds **no API keys**.

Three modes (tabs at the top of the panel):

- **Coach** — context-aware chat about the page you're on.
- **Train** — for experienced team members: record yourself doing a task in
  DataHub and instaboard turns it into a walkthrough that teaches new hires.
- **Learn** — for new hires: follow trainer-recorded walkthroughs step by
  step, with live "you're here" detection as you browse.

## Install (unpacked)

1. Start the backend: `npm run dev` in the repo root (and have DataHub running + seeded).
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the instaboard icon and click it — the side panel opens.

If your backend isn't on `http://localhost:3000`, click the ⚙ icon in the
panel and set the URL (stored in `chrome.storage.local`).

> The backend must have `LLM_PROVIDER` / `LLM_API_KEY` set in `.env.local` —
> keys pasted in the web app's Settings live in that browser tab's
> localStorage and are not visible to the extension.

## How it works

- `background.js` — opens the side panel when the toolbar icon is clicked.
- `content.js` — runs on DataHub pages (`localhost:9002`, `*.acryl.io`,
  `*.datahubproject.io`); extracts the entity URN from the URL, the page
  title, and any selected text.
- `sidepanel.js` — chat UI. On every message it captures the current tab's
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

## Trainer mode (Train tab)

1. Name the task (e.g. *"Check why revenue looks off"*), click **Start
   recording**, then just do the task in DataHub. The panel watches your
   screen's context — every entity page you visit becomes a step. Add a note
   to the current step to explain *why* you're there; select text on the page
   to highlight what matters.
2. Click **Stop**, prune any accidental steps, then **Generate walkthrough**.
   The backend agent enriches every step through the DataHub MCP server
   (`get_entities`, `get_lineage`, `get_dataset_queries`) so instructions cite
   real owners, tags, and saved SQL — you see every call in the tool trace.
3. Click **Save to DataHub** — the walkthrough is written back to the catalog
   via `save_document` (topics: `training`, `walkthrough`), so it's a normal
   catalog document, discoverable in DataHub itself.

## Trainee mode (Learn tab)

Lists every training walkthrough found in the DataHub catalog. Open one and
follow along: as you browse DataHub, the step matching the page on screen
lights up ("you're here") and is checked off automatically. Progress is saved
locally. Stuck? **Ask about this step** jumps to the Coach chat pre-loaded
with the step's entity and instruction, and the agent answers from the live
catalog. Each walkthrough ends with a short quiz whose answers are grounded
in catalog facts.
