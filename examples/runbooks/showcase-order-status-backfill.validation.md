# Runbook validation: Monthly order-status backfill check

✅ Still accurate — every catalog fact this runbook depends on checks out.

Checked 2026-08-02 against live DataHub — 2 steps across 2 entities.
Runbook recorded 2026-08-02 by Julia Novak.

No drift detected.

## Provenance

11 catalog claims in this runbook, each pinned to the version of the catalog aspect it was validated against. 11 still hold; 11 sit on aspects that have not changed at all since the runbook was recorded.

```
✓ step 1 · ORDER_HISTORY is in the catalog. — schema@4f728ef0ad52 (2026-08-02) → schema@4f728ef0ad52
✓ step 1 · ORDER_HISTORY has a column `as_of_date`, which this step reads. — schema@4f728ef0ad52 (2026-08-02) → schema@4f728ef0ad52
✓ step 1 · ORDER_HISTORY has a column `order_status`, which this step reads. — schema@4f728ef0ad52 (2026-08-02) → schema@4f728ef0ad52
✓ step 1 · ORDER_HISTORY has a column `order_total`, which this step reads. — schema@4f728ef0ad52 (2026-08-02) → schema@4f728ef0ad52
✓ step 1 · ORDER_HISTORY is not deprecated. — deprecation@ea9a6f4c3e7f (2026-08-02) → deprecation@ea9a6f4c3e7f
✓ step 1 · ORDER_HISTORY has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-08-02) → health@6f3f70fb7154
✓ step 2 · ORDER_DETAILS is in the catalog. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 2 · ORDER_DETAILS has a column `order_status`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 2 · ORDER_DETAILS has a column `order_total`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 2 · ORDER_DETAILS is not deprecated. — deprecation@ea9a6f4c3e7f (2026-08-02) → deprecation@ea9a6f4c3e7f
✓ step 2 · ORDER_DETAILS has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-08-02) → health@6f3f70fb7154
```

---
_Validated automatically by instaboard against the DataHub catalog._