# Handoff: Weekly order revenue pack for the commercial review

Recorded by **David Kim** (Data Scientist (Data Steward, ORDER_DETAILS)) on 2026-08-02.

How I build the Monday commercial pack: check the order fact is healthy, pull revenue and delivery cost by customer class off ORDER_DETAILS, then cross-check the line-item detail before anyone quotes the number.

## Step 1: Confirm ORDER_DETAILS is healthy and current

Open ORDER_DETAILS in the analytics schema. Check the health badge for failing assertions or open incidents, and confirm the Data Freshness SLA property still reads Daily before you trust today's numbers.

**Why:** This is the certified wide order table — it carries the Most Queried tag and a 97.5 quality score. If it is stale, every number in the pack is stale, and I would rather find that out here than in the meeting.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)`

**Tips:** ORDER_DETAILS_REPLICA has the same 55 columns and no owner. Do not use it — it exists because someone cloned the table and left.

## Step 2: Pull revenue and delivery cost by customer class

Run the aggregation below. order_total is the glossary-sanctioned measure; cost_of_delivery is what the commercial team wants netted off it.

**Why:** The Revenue by Customer Class glossary term prescribes grouping on customer_class and aggregating order_total. Deriving it any other way produces a number finance will dispute.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)`

```sql
SELECT customer_class,
       SUM(order_total)      AS total_revenue,
       SUM(cost_of_delivery) AS delivery_cost,
       COUNT(DISTINCT order_id) AS order_count
FROM order_entry_db.analytics.order_details
WHERE order_date >= DATEADD(day, -7, CURRENT_DATE)
GROUP BY customer_class
ORDER BY total_revenue DESC;
```

**Tips:** cost_of_delivery is on the wide table already — do not join back to orders for it.

## Step 3: Cross-check against the line items

Reconcile the weekly total against ORDER_ITEMS. If unit_price × quantity does not land within a rounding tolerance of the order_total sum, something upstream double-counted.

**Why:** We shipped a wrong number once because a retry duplicated line items. Reconciling takes two minutes and has caught it twice since.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.order_items,PROD)`

```sql
SELECT SUM(unit_price * quantity) AS line_item_total
FROM order_entry_db.order_entry.order_items;
```

---
_Recorded with instaboard. Open the instaboard extension beside DataHub to replay this handoff step by step._