# Handoff: Reading the order detail table

Recorded by **Michael** (Analytics Engineer) on 2026-08-02.

This runbook guides you through the certified wide order table (order_details) — the authoritative denormalized view of orders, customers, products, promotions, and fulfillment. It covers key fields, ownership, PII handling, and how to query common metrics like order totals and revenue by customer class. The table is refreshed daily, has a 97.5% data quality score, and powers the Promotions Performance data product.

## Step 1: Open the certified order_details table

Navigate to the order_details table page and review the schema, focusing on the PII-marked columns (cust_email, phone_number, billing/shipping address fields, customer_id, names) and the key metric columns (order_total, line_total, discount_amount, discount_percent, customer_class).

**Why:** Michael noted: "Start here. This is the certified wide order table, not the replica." The catalog confirms this is the authoritative denormalized view (materialized as a table) joining 10+ source tables, with a grain of one row per order line item. It carries the 'Authoritative Source' tag and 'Certified' glossary term, and is the core asset in the Promotions Performance data product.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)`

```sql
-- Total revenue
SELECT SUM(order_total) FROM order_entry_db.analytics.order_details;

-- Average order value
SELECT AVG(order_total) FROM order_entry_db.analytics.order_details;

-- Revenue by customer class
SELECT customer_class,
       SUM(order_total) as total_revenue,
       COUNT(DISTINCT order_id) as order_count,
       AVG(order_total) as avg_order_value
FROM order_entry_db.analytics.order_details
GROUP BY customer_class
ORDER BY total_revenue DESC;

-- Revenue by date
SELECT order_date, SUM(order_total)
FROM order_entry_db.analytics.order_details
GROUP BY order_date;
```

**Tips:** Owners: Technical Owner = DataHub SE Team (group); Data Stewards = David Kim (david.kim@example.com) and Julia Novak (julia.novak@example.com). Business escalation contact = Ian Chen (ian.chen@example.com, Director of Data Engineering). PII glossary term applied at table level; multiple columns have explicit PII tags (cust_email, phone_number, billing_address_line1/2, billing_zipcode, cust_first_name, cust_last_name, customer_id, shipping_address_line1/2, shipping_country, shipping_town_city, shipping_zipcode). Handle per privacy policy. Tags: Large Table (storage footprint), Most Queried (high usage). Data Freshness SLA = Daily; Data Quality Score = 97.5; Retention = 1 year. Domain = Ecommerce Operations. Cost Center = Marketing. No active incidents (health check PASS). No manual or system queries stored in catalog — use the glossary-term SQL patterns above as starting points.

---
_Recorded with instaboard. Open the instaboard extension beside DataHub to replay this handoff step by step._