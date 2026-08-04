# Sample runbooks

Every file here is real output. The tool produced it against a live DataHub and
`npm run examples` copied it out. Nothing in this directory is hand-maintained,
so a runbook that reads badly is the tool reading badly.

Three files per runbook:

| File | What it is |
| --- | --- |
| `<id>.md` | the runbook as it is written back into DataHub with `save_document` |
| `<id>.json` | the same runbook plus its catalog baseline: every snapshot, every aspect fingerprint, every pinned claim and its verdict |
| `<id>.validation.md` | the drift note from its last validation, which is the document that lands in the catalog when it goes stale |

| Runbook | Task | Steps | Claims holding | Last validation | Report |
| --- | --- | --- | --- | --- | --- |
| [`sample-monthly-mrr-report.md`](sample-monthly-mrr-report.md) | Monthly MRR report for the board deck | 3 | 18/19 | warning | [report](sample-monthly-mrr-report.validation.md) |
| [`reading-the-order-detail-table-msc00u1p.md`](reading-the-order-detail-table-msc00u1p.md) | Reading the order detail table | 1 | 26/26 | ok | [report](reading-the-order-detail-table-msc00u1p.validation.md) |
| [`showcase-weekly-order-revenue.md`](showcase-weekly-order-revenue.md) | Weekly order revenue pack for the commercial review | 3 | 16/16 | ok | [report](showcase-weekly-order-revenue.validation.md) |
| [`showcase-promotion-margin-review.md`](showcase-promotion-margin-review.md) | Promotion margin review before a campaign launch | 2 | 16/16 | ok | [report](showcase-promotion-margin-review.validation.md) |
| [`showcase-order-status-backfill.md`](showcase-order-status-backfill.md) | Monthly order-status backfill check | 2 | 11/11 | ok | [report](showcase-order-status-backfill.validation.md) |

The `showcase-*` runbooks lean on `showcase-ecommerce`, the demo datapack DataHub
publishes, so anyone can re-validate them against a catalog nobody here built.
`reading-the-order-detail-table-*` is a raw capture from the Chrome extension,
made by someone browsing DataHub while the agent enriched each visit from the
catalog.

## What to look at

**The `why` on every step.** That field walks out of the door with the person who
leaves, which is what makes a runbook worth keeping.
`sample-monthly-mrr-report.md` step 2 explains why the step reads
`net_amount_usd` and leaves `gross_amount_usd` alone, and that one sentence is
the whole point of the exercise.

**The provenance block at the end of each validation report.** Every claim the
runbook makes about the catalog, pinned to the fingerprint of the aspect it was
validated against, with what that aspect reads today:

```
✓ step 2 · fct_revenue has a column `net_amount_usd`, which this step reads. — schema@89280579c9b0 (2026-07-01) → schema@89280579c9b0
✗ step 1 · payment_health_daily has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-07-01) → health@b3b7361fb1ae
```

The fingerprints are content hashes of public catalog facts, so anyone holding
the runbook and a DataHub connection can recompute them and check the pin. That
recomputation is what makes it a provenance chain.

**The claim count.** `18/19 claims hold` tells a reader the runbook is followable
apart from one specific thing, and then names the thing.

## Corrections

When a runbook does break, `npm run propose` derives the correction from the
catalog and writes it to `proposals/` as a reviewable diff. See
[`../../proposals/`](../../proposals) after a run, or the worked example in
[`../live/prove-loop-receipts.json`](../live/prove-loop-receipts.json), which
carries the diff produced when `npm run prove` renamed a column out from under
this exact runbook.

## Regenerating

```bash
npm run validate     # re-check every stored runbook against the catalog
npm run examples     # copy them out to here
```
