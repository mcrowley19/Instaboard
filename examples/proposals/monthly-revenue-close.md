# Proposed runbook correction: Monthly revenue close

Validation on 2026-08-02 found 3 problems with this runbook (severity: broken). Every correction below is derived from the catalog, not generated — the rationale names the evidence.

**Reviewers:** Priya Patel

## Proposed edits

| Step | Change | From | To | Confidence | Why |
| --- | --- | --- | --- | --- | --- |
| 2 | column-rename | `net_amount_usd` | `net_revenue_usd` | medium | `net_revenue_usd` is on fct_revenue now and was not when this runbook was recorded, and it is the closest match to `net_amount_usd` (0.64). |
| 2 | owner-update | `Mike Rodriguez` | `Priya Patel` | medium | DataHub lists Priya Patel as the owner today. Pronouns referring to Mike Rodriguez were repointed to Priya; check the prose reads right. |
| 3 | dataset-replacement | `mrr_monthly` | `analytics.marts.mrr_monthly_v2` | high | DataHub's deprecation note on mrr_monthly names it: "Rebuilt with plan-level grain at the FY close. Use analytics.marts.mrr_monthly_v2 instead.". |

## Needs a person

These are deliberately not auto-corrected. Guessing here would be worse than asking.

- **Step 3 (newly-deprecated)** — mrr_monthly has been deprecated since this runbook was written. The deprecation note names `analytics.marts.mrr_monthly_v2`, which is a table name rather than a URN, so this step's entity link still points at the deprecated dataset. Repoint it once the replacement is in the catalog.

## Diff

```diff
--- a/runbooks/prove-monthly-revenue-close.md
+++ b/runbooks/prove-monthly-revenue-close.md
@@ -18,31 +18,33 @@
 
 ## Step 2: Pull net revenue for the month
 
-Sum net_amount_usd from fct_revenue for the close month. Use net_amount_usd, never gross_amount_usd — gross is before refunds and will not tie to the bank.
+Sum net_revenue_usd from fct_revenue for the close month. Use net_revenue_usd, never gross_amount_usd — gross is before refunds and will not tie to the bank.
 
 **Why:** Finance reconciles to settled cash, so refunds have to be out before the number leaves this step.
 
 **Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)`
 
 ```sql
-SELECT DATE_TRUNC('month', revenue_date) AS month, SUM(net_amount_usd) AS net_revenue
+SELECT DATE_TRUNC('month', revenue_date) AS month, SUM(net_revenue_usd) AS net_revenue
 FROM analytics.marts.fct_revenue
 GROUP BY 1 ORDER BY 1 DESC;
 ```
 
-**Tips:** If the total looks short, ping Mike Rodriguez — he owns the dbt job that loads this table.
+**Tips:** If the total looks short, ping Priya Patel — Priya owns the dbt job that loads this table.
 
 ## Step 3: Reconcile against the MRR rollup
 
-Compare the recurring slice of the number above against mrr_usd in mrr_monthly for the same month. They should agree to within rounding; if they don't, the rollup ran before the fact finished loading.
+Compare the recurring slice of the number above against mrr_usd in analytics.marts.mrr_monthly_v2 for the same month. They should agree to within rounding; if they don't, the rollup ran before the fact finished loading.
 
 **Why:** The board deck quotes MRR and finance quotes net revenue. If those two disagree in public it is a bad month.
 
 **Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.mrr_monthly,PROD)`
 
 ```sql
-SELECT month, SUM(mrr_usd) AS mrr FROM analytics.marts.mrr_monthly GROUP BY 1 ORDER BY 1 DESC LIMIT 12;
+SELECT month, SUM(mrr_usd) AS mrr FROM analytics.marts.mrr_monthly_v2 GROUP BY 1 ORDER BY 1 DESC LIMIT 12;
 ```
 
+**Tips:** mrr_monthly was deprecated after this runbook was recorded; DataHub's deprecation note points here instead.
+
 ---
 _Recorded with instaboard. Open the instaboard extension beside DataHub to replay this handoff step by step._
```

---
_Proposed by instaboard's runbook decay sweep. Detection and correction are both deterministic reads of the DataHub catalog; approving this is a human decision._