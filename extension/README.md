# instaboard Chrome extension

A Manifest V3 side panel that coaches new hires **while they browse DataHub**.
It is a thin client: every LLM call, MCP call, and secret stays on the
instaboard backend — the extension holds **no API keys**.

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
