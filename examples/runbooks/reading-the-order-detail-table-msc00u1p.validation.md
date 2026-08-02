# Runbook validation: Reading the order detail table

✅ Still accurate — every catalog fact this runbook depends on checks out.

Checked 2026-08-02 against live DataHub — 1 step across 1 entity.
Runbook recorded 2026-08-02 by Michael.

No drift detected.

## Provenance

26 catalog claims in this runbook, each pinned to the version of the catalog aspect it was validated against. 26 still hold; 26 sit on aspects that have not changed at all since the runbook was recorded.

```
✓ step 1 · ORDER_DETAILS is in the catalog. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `cust_email`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `phone_number`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `billing_address_line1`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `billing_zipcode`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `cust_first_name`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `cust_last_name`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `customer_class`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `customer_id`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `discount_amount`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `discount_percent`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `line_total`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `order_date`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `order_id`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `order_total`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `shipping_address_line1`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `shipping_country`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `shipping_town_city`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS has a column `shipping_zipcode`, which this step reads. — schema@3f98350c8745 (2026-08-02) → schema@3f98350c8745
✓ step 1 · ORDER_DETAILS is not deprecated. — deprecation@ea9a6f4c3e7f (2026-08-02) → deprecation@ea9a6f4c3e7f
✓ step 1 · ORDER_DETAILS has no open incidents and no failing assertions. — health@6f3f70fb7154 (2026-08-02) → health@6f3f70fb7154
✓ step 1 · DataHub SE Team owns ORDER_DETAILS, and is who this step says to contact. — ownership@06a2431b52d3 (2026-08-02) → ownership@06a2431b52d3
✓ step 1 · David Kim owns ORDER_DETAILS, and is who this step says to contact. — ownership@06a2431b52d3 (2026-08-02) → ownership@06a2431b52d3
✓ step 1 · david.kim@example.com owns ORDER_DETAILS, and is who this step says to contact. — ownership@06a2431b52d3 (2026-08-02) → ownership@06a2431b52d3
✓ step 1 · Julia Novak owns ORDER_DETAILS, and is who this step says to contact. — ownership@06a2431b52d3 (2026-08-02) → ownership@06a2431b52d3
✓ step 1 · julia.novak@example.com owns ORDER_DETAILS, and is who this step says to contact. — ownership@06a2431b52d3 (2026-08-02) → ownership@06a2431b52d3
```

---
_Validated automatically by instaboard against the DataHub catalog._