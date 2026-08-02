# Handoff: Promotion margin review before a campaign launch

Recorded by **Karen Okonkwo** (Technical Owner, PowerBI ORDER_DETAILS) on 2026-08-02.

What I check before signing off a promotion: the campaign window and cost in PROMOTIONS, then the product catalogue for list vs min price, so we know the floor before marketing commits a discount.

## Step 1: Read the campaign window and cost

Open PROMOTIONS and pull promotion_start_date, promotion_end_date and promotion_cost for the campaign under review.

**Why:** Marketing quotes a discount percentage; the number that matters to us is promotion_cost against the margin the products can absorb.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.promotions,PROD)`

```sql
SELECT promotion_name, promotion_start_date, promotion_end_date, promotion_cost
FROM order_entry_db.order_entry.promotions;
```

## Step 2: Check the price floor on the affected products

Open the products model and compare list_price against min_price for everything in the campaign's categories. min_price is the floor — a discount below it needs sign-off.

**Why:** min_price is the contractual floor, not a suggestion. Ask Priya Sharma before agreeing to anything under it; she stewards this model and knows which supplier agreements bind us.

**Entity:** `urn:li:dataset:(urn:li:dataPlatform:dbt,b2fd91.order_entry_db.order_entry.products,PROD)`

```sql
SELECT product_id, product_name, list_price, min_price
FROM order_entry_db.order_entry.products
WHERE product_status = 'orderable';
```

**Tips:** Priya Sharma is the Data Steward on this model — she is the sign-off for anything below min_price.

---
_Recorded with instaboard. Open the instaboard extension beside DataHub to replay this handoff step by step._