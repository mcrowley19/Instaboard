# The Chrome side panel, verified on 2026-08-02

The side panel is a thin client. It reads the entity off whatever DataHub page you are
looking at, posts that to the backend, and renders what streams back. Two requests carry
everything. If those work against a live catalog, the panel works.

So they are captured, with a real entity from DataHub's own `showcase-ecommerce` datapack:
[`examples/live/extension-receipt.json`](../examples/live/extension-receipt.json).

```bash
npm run dev                 # backend on :3000, pointed at a live DataHub
npm run receipts:extension
```

## What the receipt shows

**Entity detection.** The URL of the page you are on:

```text
http://localhost:9002/dataset/urn%3Ali%3Adataset%3A(urn%3Ali%3AdataPlatform%3Asnowflake%2Cb2fd91.order_entry_db.analytics.order_details%2CPROD)/Schema
```

goes through the regex in `extension/content.js` and comes back as
`{ entityType: "dataset", datasetUrn: "urn:li:dataset:(...analytics.order_details,PROD)" }`.
The receipt script reads that regex out of the shipped content script rather than restating
it, so the two cannot drift. `tests/extension.test.ts` pins the same behaviour on five more
URLs, including a glossary term, a domain, a search page with no entity, and a URL with a
broken percent-escape.

**Ask the coach.** With that context attached, `/api/chat` made 5 DataHub calls
(`get_entities`, `get_lineage` ×3, `get_dataset_queries`) and came back with the table's
purpose, its stewards, its upstreams, and the warning that `ORDER_DETAILS_REPLICA` sits
next to it unowned.

**Record a handoff.** `/api/handoffs` took a one-page trail plus the note typed into the
panel and returned an enriched runbook: a step whose "why" quotes the recorder and then
cites what the catalog says backs it up, real SQL lifted from the `Order Total` glossary
term rather than invented, and a snapshot of the entity for later decay checks. It wrote
the runbook into DataHub and reported the document URN
`urn:li:document:shared-e3a81563-0f42-44c6-aa6a-f23a9cb7c686`.

## What is still missing, and why

There is no GIF of the panel sitting beside the DataHub UI. Chrome renders a side panel as
part of the browser frame, outside any tab, so the automation used for the other captures
in this repo cannot photograph it. Recording it takes a person with the extension loaded.

If you want to record one, here is the shot list. Two minutes, one take.

1. `npm run dev` with `DEMO_MODE` unset and DataHub up. Load
   `chrome://extensions` → Developer mode → **Load unpacked** → the `extension/` folder.
2. Open `http://localhost:9002` and go to the Snowflake `ORDER_DETAILS` dataset.
3. Click the instaboard icon. The panel opens and the context line at the top reads
   **order_details**, picked up from the page you are on. Hold for a beat so it is legible.
4. Type *"what should I be careful about before using this?"*. Let the tool trace expand
   while it answers, then scroll the answer.
5. Click ● **Record**. Click through to Lineage, then to the `ORDER_ITEMS` upstream, adding
   a note on each page ("reconcile against line items before quoting a total").
6. Stop recording. Wait for the runbook to build, then show the enriched steps.
7. Save as `docs/media/extension-record.gif` and drop it under the Chrome extension
   section of the README with a caption naming the DataHub instance it ran against.

Everything in that sequence is exercised by the committed receipt already. The GIF adds a
picture of it happening.
