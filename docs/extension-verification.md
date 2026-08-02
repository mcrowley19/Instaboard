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

Everything in the sequence below is already exercised by the committed receipt. A GIF adds
a picture of it happening.

## Shot list

### Before you hit record

```bash
npm run datahub:up                        # DataHub on :9002, GMS on :8080
datahub datapack load showcase-ecommerce  # if it isn't loaded already
npm run dev                               # backend on :3000, DEMO_MODE unset
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → the
`extension/` folder. Then open the Snowflake `ORDER_DETAILS` dataset and leave the tab
sitting there:

```text
http://localhost:9002/dataset/urn%3Ali%3Adataset%3A(urn%3Ali%3AdataPlatform%3Asnowflake%2Cb2fd91.order_entry_db.analytics.order_details%2CPROD)/Schema
```

Close anything private. `screencapture` takes the whole desktop.

### Roll

```bash
screencapture -v -V 150 -x /tmp/extension-take.mov
```

`-V` fixes the duration, so a stray keypress cannot cut it short. Switch to Chrome the
moment you press enter. 150 seconds is comfortable for all six beats.

| # | Beat | What to do | Hold for |
| --- | --- | --- | --- |
| 1 | Establish | Chrome on the `ORDER_DETAILS` page, panel closed | 3s |
| 2 | **Entity detection** | Click the instaboard toolbar icon. The panel opens and its context line reads **order_details**, read off the page you are on. This is the beat that matters most, so let it sit still | 5s |
| 3 | Ask the coach | Type *what should I be careful about before using this?* and send. Let the tool trace expand on its own, then scroll the answer once it lands | until it finishes, then 4s |
| 4 | Start recording | Click ● **Record** in the panel | 2s |
| 5 | Walk the task | In the DataHub tab click **Lineage**, then open the **ORDER_ITEMS** upstream. Watch the panel's context line change to **ORDER_ITEMS** on its own. Add the note *reconcile against line items before quoting a total* | 6s on the context change |
| 6 | The runbook | Stop recording in the panel. Wait for the runbook to build, then scroll its enriched steps | until built, then 5s |

Beat 5 is the one worth being patient with. The context line changing while you navigate is
the whole claim about the panel following you around DataHub.

### Convert

```bash
# trim the dead air at either end (adjust -ss and -t after watching it back),
# scale to something a README can carry, and cap the frame rate
ffmpeg -i /tmp/extension-take.mov -ss 00:00:02 -t 00:02:20 \
  -vf "fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  -loop 0 docs/media/extension-record.gif
```

Check the size. Anything over about 8 MB is worth another pass at `fps=8` or
`scale=1000:-1`.

### Then

Drop it under the **Two surfaces, one backend** section of the README, with a caption
naming the catalog it ran against, the same way the validation GIF at the top of the README
names its DataHub instance.
