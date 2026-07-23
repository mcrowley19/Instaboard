# Sample SQL from the seeded catalog

These are the saved queries the seed script (`npm run seed`) attaches to the demo
datasets. In the app, ask *"Show me SQL for churn analysis"* and the agent
retrieves them live via the `get_dataset_queries` MCP tool.

## Monthly MRR trend by plan (`analytics.marts.mrr_monthly`)

```sql
SELECT month, plan, mrr_usd, net_new_mrr_usd
FROM analytics.marts.mrr_monthly
WHERE month >= DATEADD(month, -12, CURRENT_DATE)
ORDER BY month, plan;
```

## Net revenue by customer country (`fct_revenue` × `dim_customers`)

```sql
SELECT c.country, SUM(r.net_amount_usd) AS net_revenue
FROM analytics.marts.fct_revenue r
JOIN analytics.marts.dim_customers c ON c.customer_id = r.customer_id
WHERE r.revenue_date >= DATEADD(day, -90, CURRENT_DATE)
GROUP BY 1 ORDER BY 2 DESC;
```

## Churn rate with 3-month rolling average (`fct_churn`)

```sql
SELECT month, plan, churn_rate,
       AVG(churn_rate) OVER (
         PARTITION BY plan ORDER BY month
         ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
       ) AS churn_rate_3mo
FROM analytics.marts.fct_churn
ORDER BY month DESC, plan;
```

## 28-day active users (`events_sessionized`)

```sql
SELECT COUNT(DISTINCT user_id) AS active_users_28d
FROM analytics.marts.events_sessionized
WHERE session_start >= DATEADD(day, -28, CURRENT_DATE)
  AND is_active_marker;
```

## Payment success rate by provider (`payment_health_daily`)

```sql
SELECT date, provider, success_rate
FROM analytics.marts.payment_health_daily
WHERE date >= DATEADD(day, -14, CURRENT_DATE)
ORDER BY date DESC, provider;
```
