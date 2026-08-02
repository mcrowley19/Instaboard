# Runbook validation: Promotion margin review before a campaign launch

✅ Still accurate — every catalog fact this runbook depends on checks out.

Checked 2026-08-02 against live DataHub — 2 steps across 2 entities.
Runbook recorded 2026-08-02 by Karen Okonkwo.

No drift detected.

## Provenance

16 catalog claims in this runbook, each pinned to the version of the catalog aspect it was validated against. 16 still hold; 16 sit on aspects that have not changed at all since the runbook was recorded.

```
✓ step 1 · PROMOTIONS is in the catalog. — schema@69e3f28c6b2c (2026-08-02) → schema@69e3f28c6b2c
✓ step 1 · PROMOTIONS has a column `promotion_cost`, which this step reads. — schema@69e3f28c6b2c (2026-08-02) → schema@69e3f28c6b2c
✓ step 1 · PROMOTIONS has a column `promotion_end_date`, which this step reads. — schema@69e3f28c6b2c (2026-08-02) → schema@69e3f28c6b2c
✓ step 1 · PROMOTIONS has a column `promotion_name`, which this step reads. — schema@69e3f28c6b2c (2026-08-02) → schema@69e3f28c6b2c
✓ step 1 · PROMOTIONS has a column `promotion_start_date`, which this step reads. — schema@69e3f28c6b2c (2026-08-02) → schema@69e3f28c6b2c
✓ step 1 · PROMOTIONS is not deprecated. — deprecation@ea9a6f4c3e7f (2026-08-02) → deprecation@ea9a6f4c3e7f
✓ step 1 · PROMOTIONS has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-08-02) → health@6f3f70fb7154
✓ step 2 · products is in the catalog. — schema@fce7ae62b628 (2026-08-02) → schema@fce7ae62b628
✓ step 2 · products has a column `list_price`, which this step reads. — schema@fce7ae62b628 (2026-08-02) → schema@fce7ae62b628
✓ step 2 · products has a column `min_price`, which this step reads. — schema@fce7ae62b628 (2026-08-02) → schema@fce7ae62b628
✓ step 2 · products has a column `product_id`, which this step reads. — schema@fce7ae62b628 (2026-08-02) → schema@fce7ae62b628
✓ step 2 · products has a column `product_name`, which this step reads. — schema@fce7ae62b628 (2026-08-02) → schema@fce7ae62b628
✓ step 2 · products has a column `product_status`, which this step reads. — schema@fce7ae62b628 (2026-08-02) → schema@fce7ae62b628
✓ step 2 · products is not deprecated. — deprecation@ea9a6f4c3e7f (2026-08-02) → deprecation@ea9a6f4c3e7f
✓ step 2 · products has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-08-02) → health@6f3f70fb7154
✓ step 2 · Priya Sharma owns products, and is who this step says to contact. — ownership@d8d5b5dea4e9 (2026-08-02) → ownership@d8d5b5dea4e9
```

---
_Validated automatically by instaboard against the DataHub catalog._