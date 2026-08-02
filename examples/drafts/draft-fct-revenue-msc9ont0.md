# Draft runbook: Working with fct_revenue

Drafted from catalog evidence on 2026-08-02 — **nobody recorded this**. Every "why" below is inferred from what the catalog holds, not from the person who did the work.

A first-pass runbook for fct_revenue, drafted from what the catalog already knows rather than from anyone's recording: 1 recorded query on the dataset, 3 direct upstreams, 1 direct downstream. Every step below is derived from catalog evidence and none of it carries the reason the original author would have given. Correct it, then it is a real runbook.

**Evidence it was drafted from:** 1 recorded query on the dataset; 3 direct upstreams; 1 direct downstream; 2 owners on record; glossary terms: Gross Merchandise Value, Monthly Recurring Revenue; not deprecated.

## Step 1: Check fct_revenue is healthy before you trust it

Open fct_revenue in DataHub and read the health badge and the deprecation field before you run anything against it. It is currently clean on both.

**Why (inferred from the catalog):** Every number produced by the steps below comes from this table. Confirming it loaded is cheaper than retracting a figure after somebody has quoted it.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)`

**Tips:** Owners on record: Priya Patel, Mike Rodriguez.

## Step 2: Confirm orders loaded first

Check orders, which feeds fct_revenue, has today's data before you read anything downstream of it.

**Why (inferred from the catalog):** DataHub records orders as a direct upstream of fct_revenue. A partial load there produces a plausible-looking but short number here, which is the failure mode that gets noticed last.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:postgres,northbeam_app.public.orders,PROD)`

## Step 3: Confirm refunds loaded first

Check refunds, which feeds fct_revenue, has today's data before you read anything downstream of it.

**Why (inferred from the catalog):** DataHub records refunds as a direct upstream of fct_revenue. A partial load there produces a plausible-looking but short number here, which is the failure mode that gets noticed last.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:postgres,northbeam_app.public.refunds,PROD)`

## Step 4: Net revenue by customer country (last 90 days)

Run this against fct_revenue. It is a query the catalog has on record for this table, not a reconstruction.

**Why (inferred from the catalog):** This is what people actually run here — the catalog has it recorded against this dataset. Reproducing an existing query is how you get a number that matches the one everyone else quotes.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)`

```sql
SELECT c.country, SUM(r.net_amount_usd) AS net_revenue
FROM analytics.marts.fct_revenue r
JOIN analytics.marts.dim_customers c ON c.customer_id = r.customer_id
WHERE r.revenue_date >= DATEADD(day, -90, CURRENT_DATE)
GROUP BY 1 ORDER BY 2 DESC;
```

## Step 5: Know who breaks if this changes

Before changing anything about fct_revenue, check its downstream lineage in DataHub. Today that is mrr_monthly.

**Why (inferred from the catalog):** DataHub records 1 dataset depending on this one. The people to warn are the owners of those, not the owners of this.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)`

---
_Drafted by instaboard from catalog evidence. Correct it with the person who does this work, and it becomes a runbook._