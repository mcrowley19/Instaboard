-- Finance close pack: net revenue by month, off the revenue fact.
-- Reads analytics.marts.fct_revenue — net_amount_usd is the column the
-- repair drill renames out from under this query.
SELECT strftime('%Y-%m', revenue_date) AS month,
       ROUND(SUM(net_amount_usd), 2) AS net_revenue,
       COUNT(*) AS payments
FROM fct_revenue
GROUP BY 1
ORDER BY 1 DESC;
