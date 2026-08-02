# Handoff: Monthly MRR report for the board deck

Recorded by **Priya Patel** (Payments Data Lead) on 2026-07-01.

How I produce the MRR numbers for the monthly board deck: sanity-check payment health first, verify the revenue fact loaded, then pull the MRR rollup and hand the numbers to finance.

## Step 1: Check payment pipeline health

Open payment_health_daily and confirm yesterday's success_rate is above 0.97 for both providers. If it dipped, the revenue numbers may undercount — check with the on-call before reporting anything.

**Why:** A payment outage silently deflates MRR. Finance has been burned by this before — always rule it out first.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.payment_health_daily,PROD)`

**Tips:** The saved query 'Payment success rate by provider' on this dataset is the fastest check.

## Step 2: Verify fct_revenue loaded cleanly

Open fct_revenue and check the dataset's last updated time and row-count trend. Use net_amount_usd for anything you report — gross_amount_usd includes refunded charges.

**Why:** fct_revenue is the canonical revenue source; every downstream number is wrong if this load was partial.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)`

```sql
SELECT MAX(revenue_date) AS latest, COUNT(*) AS rows_loaded
FROM analytics.marts.fct_revenue
WHERE revenue_date >= DATEADD(day, -35, CURRENT_DATE);
```

**Tips:** If latest is more than a day behind, ping Mike Rodriguez — the dbt mart job may have failed.

## Step 3: Pull the MRR rollup

Open mrr_monthly and run the saved query 'Monthly MRR trend by plan' for the last 12 months. Copy mrr_usd and net_new_mrr_usd into the board template.

**Why:** This table implements the official MRR definition (glossary term MRR) — never recompute it by hand from payments.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.mrr_monthly,PROD)`

```sql
SELECT month, plan, mrr_usd, net_new_mrr_usd
FROM analytics.marts.mrr_monthly
WHERE month >= DATEADD(month, -12, CURRENT_DATE)
ORDER BY month, plan;
```

**Tips:** Board deck wants plan-level rows plus a total — the total is the SUM over plans, not a separate table.

---
_Recorded with instaboard. Open the instaboard extension beside DataHub to replay this handoff step by step._