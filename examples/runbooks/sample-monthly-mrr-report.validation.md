# Runbook validation: Monthly MRR report for the board deck

⚠️ 1 thing to know before following this runbook.

Checked 2026-08-02 against live DataHub — 3 steps across 3 entities.
Runbook recorded 2026-07-01 by Priya Patel.

## ⚠️ Step 1: Check payment pipeline health

**failing-assertion** — payment_health_daily has 1 failing assertion (freshness/volume) (was 0 when recorded).

The table may be stale. Confirm it has loaded before trusting this step's output.

<sub>Provenance: this step's claim that payment_health_daily has no open incidents and no failing assertions was validated on 2026-07-01 against `health@6f3f70fb7154`; that aspect now reads `health@b3b7361fb1ae`. Claim id `healthy:f970c7659588`.</sub>

## Provenance

19 catalog claims in this runbook, each pinned to the version of the catalog aspect it was validated against. 18 still hold; 17 sit on aspects that have not changed at all since the runbook was recorded.

```
✓ step 1 · payment_health_daily is in the catalog. — schema@dd40a83770de (2026-07-01) → schema@dd40a83770de
✓ step 1 · payment_health_daily has a column `provider`, which this step reads. — schema@dd40a83770de (2026-07-01) → schema@dd40a83770de
✓ step 1 · payment_health_daily has a column `success_rate`, which this step reads. — schema@dd40a83770de (2026-07-01) → schema@dd40a83770de
✓ step 1 · payment_health_daily is not deprecated. — deprecation@ea9a6f4c3e7f (2026-07-01) → deprecation@ea9a6f4c3e7f
✗ step 1 · payment_health_daily has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-07-01) → health@b3b7361fb1ae
✓ step 2 · fct_revenue is in the catalog. — schema@89280579c9b0 (2026-07-01) → schema@89280579c9b0
✓ step 2 · fct_revenue has a column `gross_amount_usd`, which this step reads. — schema@89280579c9b0 (2026-07-01) → schema@89280579c9b0
✓ step 2 · fct_revenue has a column `net_amount_usd`, which this step reads. — schema@89280579c9b0 (2026-07-01) → schema@89280579c9b0
✓ step 2 · fct_revenue has a column `revenue_date`, which this step reads. — schema@89280579c9b0 (2026-07-01) → schema@89280579c9b0
✓ step 2 · fct_revenue is not deprecated. — deprecation@ea9a6f4c3e7f (2026-07-01) → deprecation@ea9a6f4c3e7f
✓ step 2 · fct_revenue has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-07-01) → health@6f3f70fb7154
✓ step 2 · Mike Rodriguez owns fct_revenue, and is who this step says to contact. — ownership@869ab9c899cc (2026-07-01) → ownership@8e5f9dd13d08
✓ step 3 · mrr_monthly is in the catalog. — schema@b3adc4e2ad41 (2026-07-01) → schema@b3adc4e2ad41
✓ step 3 · mrr_monthly has a column `month`, which this step reads. — schema@b3adc4e2ad41 (2026-07-01) → schema@b3adc4e2ad41
✓ step 3 · mrr_monthly has a column `plan`, which this step reads. — schema@b3adc4e2ad41 (2026-07-01) → schema@b3adc4e2ad41
✓ step 3 · mrr_monthly has a column `mrr_usd`, which this step reads. — schema@b3adc4e2ad41 (2026-07-01) → schema@b3adc4e2ad41
✓ step 3 · mrr_monthly has a column `net_new_mrr_usd`, which this step reads. — schema@b3adc4e2ad41 (2026-07-01) → schema@b3adc4e2ad41
✓ step 3 · mrr_monthly is not deprecated. — deprecation@ea9a6f4c3e7f (2026-07-01) → deprecation@ea9a6f4c3e7f
✓ step 3 · mrr_monthly has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-07-01) → health@6f3f70fb7154
```

---
_Validated automatically by instaboard against the DataHub catalog._