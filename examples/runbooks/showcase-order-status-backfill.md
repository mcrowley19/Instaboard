# Handoff: Monthly order-status backfill check

Recorded by **Julia Novak** (Data Quality Engineer (Data Steward, ORDER_DETAILS)) on 2026-08-02.

The month-end check that order statuses settled correctly: read the as-of snapshots out of ORDER_HISTORY, compare against the live order state, and flag anything that moved after close.

## Step 1: Read the month-end snapshots from ORDER_HISTORY

Query ORDER_HISTORY for the last as_of_date in the closing month. This table is the incremental history — one row per order per snapshot date — so filter to a single as_of_date or you will count every order once per day it existed.

**Why:** Finance closes on the snapshot, not on live state. If we compare against live orders we will 'find' discrepancies that are just legitimate post-close movement.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_history,PROD)`

```sql
SELECT order_status, COUNT(*) AS orders, SUM(order_total) AS value
FROM order_entry_db.analytics.order_history
WHERE as_of_date = (SELECT MAX(as_of_date) FROM order_entry_db.analytics.order_history)
GROUP BY order_status;
```

## Step 2: Compare against the live order state

Run the same grouping against ORDER_DETAILS and diff the two. Anything that changed status after the snapshot date is what the commercial team needs to see.

**Why:** The whole point of the check is the delta. ORDER_DETAILS is the live certified view; ORDER_HISTORY is what we told finance last month.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)`

```sql
SELECT order_status, COUNT(*) AS orders, SUM(order_total) AS value
FROM order_entry_db.analytics.order_details
GROUP BY order_status;
```

---
_Recorded with instaboard. Open the instaboard extension beside DataHub to replay this handoff step by step._