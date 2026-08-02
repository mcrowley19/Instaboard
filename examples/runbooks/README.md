# Sample runbooks

Real output, not illustrations. Every file here was produced by the tool against a
live DataHub and copied out with `npm run examples`. Nothing in this directory is
hand-maintained, so if a runbook reads badly, that is the tool reading badly.

Three files per runbook:

| File | What it is |
| --- | --- |
| `<id>.md` | the runbook as it is written back into DataHub with `save_document` |
| `<id>.json` | the same runbook plus its catalog baseline — every snapshot, every aspect fingerprint, every pinned claim and its verdict |
| `<id>.validation.md` | the drift note from its last validation, which is the document that lands in the catalog when it goes stale |

| Runbook | Task | Steps | Claims holding | Last validation | Report |
| --- | --- | --- | --- | --- | --- |
| [`sample-monthly-mrr-report.md`](sample-monthly-mrr-report.md) | Monthly MRR report for the board deck | 3 | 18/19 | warning | [report](sample-monthly-mrr-report.validation.md) |
| [`reading-the-order-detail-table-msc00u1p.md`](reading-the-order-detail-table-msc00u1p.md) | Reading the order detail table | 1 | 26/26 | ok | [report](reading-the-order-detail-table-msc00u1p.validation.md) |
| [`showcase-weekly-order-revenue.md`](showcase-weekly-order-revenue.md) | Weekly order revenue pack for the commercial review | 3 | 16/16 | ok | [report](showcase-weekly-order-revenue.validation.md) |
| [`showcase-promotion-margin-review.md`](showcase-promotion-margin-review.md) | Promotion margin review before a campaign launch | 2 | 16/16 | ok | [report](showcase-promotion-margin-review.validation.md) |
| [`showcase-order-status-backfill.md`](showcase-order-status-backfill.md) | Monthly order-status backfill check | 2 | 11/11 | ok | [report](showcase-order-status-backfill.validation.md) |

The `showcase-*` runbooks lean on `showcase-ecommerce`, the demo datapack DataHub
publishes, so they can be re-validated against a catalog nobody here built.
`reading-the-order-detail-table-*` is a raw capture from the Chrome extension —
someone browsing DataHub, with the agent enriching each visit from the catalog.

## What to look at

**The `why` on every step.** It is the field that walks out of the door with the
person who leaves, and it is the reason a runbook is worth keeping. `sample-monthly-mrr-report.md`
step 2 explains why `net_amount_usd` and not `gross_amount_usd`; that sentence is
the whole point of the exercise.

**The provenance block at the end of each validation report.** Every claim the
runbook makes about the catalog, pinned to the fingerprint of the aspect it was
validated against, with what that aspect reads today:

```
✓ step 2 · fct_revenue has a column `net_amount_usd`, which this step reads. — schema@89280579c9b0 (2026-07-01) → schema@89280579c9b0
✗ step 1 · payment_health_daily has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-07-01) → health@b3b7361fb1ae
```

The fingerprints are content hashes of public catalog facts, so anyone with the
runbook and a DataHub connection can recompute them and check the pin. That is
what makes it a provenance chain rather than an assertion of one.

**The claim count.** `18/19 claims hold` is a more useful answer than "stale":
it says the runbook is followable apart from one specific thing, and names it.

## Corrections

When a runbook does break, `npm run propose` derives the correction from the
catalog and writes it to `proposals/` as a reviewable diff — see
[`../../proposals/`](../../proposals) after a run, or the worked example in
[`../live/prove-loop-receipts.json`](../live/prove-loop-receipts.json), which
carries the diff produced when `npm run prove` renamed a column out from under
this exact runbook.

## Regenerating

```bash
npm run validate     # re-check every stored runbook against the catalog
npm run examples     # copy them out to here
```
