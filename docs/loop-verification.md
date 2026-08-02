# The loop, proved end to end, 2026-08-02

The headline claim is a loop: capture knowledge into the catalog, notice when the catalog
moves out from under it, and do something about it. A README can assert that. This is the
command that proves it.

```bash
npm run prove                        # the catalog this repo seeds
npm run prove -- --catalog=showcase  # DataHub's own showcase-ecommerce datapack
```

**Result: 29/29 checks passed on both catalogs.** Full output at
[`prove-loop-receipts.json`](../examples/live/prove-loop-receipts.json) and
[`prove-loop-receipts-showcase.json`](../examples/live/prove-loop-receipts-showcase.json),
both of which CI re-verifies on every push
([`tests/prove-receipts.test.ts`](../tests/prove-receipts.test.ts)) so a stale or partial
capture fails the build.

Running the same proof on DataHub's own datapack is the point of the second run: it is a
catalog nobody here authored, and it found two real defects on its first outing — a rename
the detector missed because edit distance punishes token reordering, and an assertion of
ours that demanded every incident be assigned even on a dataset with no owners. Both are
fixed; see the commit history.

For how good the detector is in aggregate rather than on three planted changes, see
`npm run bench:drift` and [`drift-benchmark.json`](../examples/live/drift-benchmark.json):
6/6 planted drifts detected, 0 of 6 decoys firing, precision and recall 100%.

## What it does

| Phase | What happens |
| --- | --- |
| 1. DataHub | Starts the quickstart if GMS isn't answering, and waits for it |
| 2. Ingest | Runs `scripts/seed_datahub.py` — 14 datasets, 4 people, glossary, assertions |
| 3. Capture | Writes a three-step runbook and snapshots the live catalog through the same code path the app uses when somebody stops recording |
| 4. Validate | Sweeps it. Expects clean: no drift, every claim holding, a passing runbook-validity assertion and the validated-against pins written to the catalog |
| 5. Break | Makes three real changes through DataHub's own write APIs |
| 6. Revalidate | Expects all three caught, written back four ways, and a correction proposed |
| 7. Restore | Puts the catalog back and re-validates. Expects green again |

The decay engine is told nothing about phase 5. It re-reads the catalog and works out what
happened.

## The three breaking changes

They are the three ways runbooks actually rot:

| Change | How | What it breaks |
| --- | --- | --- |
| `fct_revenue.net_amount_usd` renamed to `net_revenue_usd` | `schemaMetadata` rewrite over the OpenAPI v3 aspect API | The column step 2's SQL sums |
| `mrr_monthly` deprecated, note naming a replacement | `updateDeprecation` mutation | The table step 3 reconciles against |
| Mike Rodriguez removed as an owner of `fct_revenue` | the MCP server's `remove_owners` | The person step 2 tells you to ping |

## What the checks assert

**Detection.** The runbook goes from `ok` to `broken`. Each change produces exactly one
finding of the right kind — `column-missing`, `newly-deprecated`, `owner-changed` — and
nothing else fires. 3 of 17 claims break; the other 14 keep holding, which is the answer a
person actually needs.

**Provenance.** Every finding carries the id of the claim it broke, and every claim carries
the fingerprint of the catalog aspect it was validated against. The format, from a committed
validation report:

```
✓ step 2 · fct_revenue has a column `net_amount_usd`, which this step reads. — schema@89280579c9b0 (2026-07-01) → schema@89280579c9b0
✗ step 1 · payment_health_daily has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-07-01) → health@b3b7361fb1ae
```

Those fingerprints hash public catalog facts, so they can be recomputed from DataHub by
anyone holding the runbook. Full example:
[`sample-monthly-mrr-report.validation.md`](../examples/runbooks/sample-monthly-mrr-report.validation.md).

**Write-back.** A drift-note Document with a URN DataHub reports back. The runbook-validity
assertion flips to `FAILURE`, carrying the specific change and the provenance chain in its
result properties. Structured properties record the status, the drift and the pins. The
drifted datasets get the `Stale Runbook` tag. An Incident is raised on each dataset where a
step would now fail — **assigned to whoever owns that dataset today**, which in the
owner-drift case is the person the runbook has never heard of.

**Action.** A correction is derived from the catalog for all three: the rename from the
column that appeared alongside the one that vanished, the replacement from the deprecation
note, the owner from the current ownership aspect. It comes out as a unified diff with the
evidence for each edit, the reviewers set to the current owners, and an explicit list of
what it refused to fix. See
[`examples/proposals/monthly-revenue-close.md`](../examples/proposals/monthly-revenue-close.md).

**Recovery.** After restore, the runbook returns to `ok`, all 17 claims hold, and the
assertion goes back to `SUCCESS`. A detector that can only ever go one way isn't one.

## Flags

```bash
npm run prove -- --skip-quickstart --skip-seed   # DataHub already up and seeded
npm run prove -- --keep-broken                   # leave the catalog changed to inspect it in the UI
npm run prove -- --json                          # receipts only
```

`--keep-broken` prints the entity URLs so you can open the incident, the tag, the failing
assertion and the structured properties in DataHub yourself. `npm run showcase:drill restore`
and the restore phase are both idempotent, so nothing is left behind by accident.
