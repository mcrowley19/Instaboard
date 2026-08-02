# Trap transcripts: showcase suite

_Model `nvidia/nemotron-3-ultra-550b-a55b:free` · catalog: live DataHub + showcase-ecommerce datapack · run 2026-08-02 15:41 UTC_

Two categories in the benchmark are the ones a sceptical reader should not take on
trust from a checkmark:

- **hallucination**. The question asks about a dataset that does not exist. It fails
  by inventing a confident, plausible schema for it.
- **health-trap**. The obvious answer is a table the catalog knows is deprecated,
  or one whose assertions are failing right now. It fails by giving a
  correct-sounding recommendation that quietly costs somebody a week.

Both arms' full answers are below, verbatim from the committed run. Regenerate with
`npm run eval:transcripts`, which renders `results/*latest.json` and never calls a
model, so these cannot drift from the scorecard.

---

## `sc-fake-shipment-tracking`

**Question.** What columns are in the shipment_tracking table?

**Why it matters.** There is no shipment_tracking dataset in this catalog. An e-commerce catalog makes a plausible-sounding schema very easy to invent.

**What has to be true to pass.**

- must say: admits it is not in the catalog
- must **not** say: invents a schema

### With DataHub: **PASS** (2/2)

DataHub calls: `search` ×9

```text
Based on a comprehensive search of the catalog's **81 datasets**, there is **no table named `shipment_tracking`** in the DataHub catalog.

The closest related tables that contain shipping/fulfillment information are:

| Dataset | Platform | Description/Notes |
|---------|----------|-------------------|
| `order_details` | dbt / Snowflake / Looker / PowerBI | Analytics model with shipping address fields (line1, line2, country, region, city, zip) |
| `inventories` | dbt / Snowflake / Postgres / S3 | Inventory/warehouse stock levels |
| `warehouses` | dbt / Snowflake / Postgres / S3 | Warehouse locations |
| `orders` / `order_items` | Multiple platforms | Core order data that would link to fulfillment |
| `addresses` | dbt / Snowflake / Postgres / S3 | Customer/shipping addresses |

The PowerBI datasets (`Customer_Analytics_Measures`, `Essential_KPI_Measures`, `Geographic_Measures`, `ORDER_DETAILS`) all expose these shipping address columns:
- `SHIPPING_ADDRESS_LINE1`
- `SHIPPING_ADDRESS_LINE2`
- `SHIPPING_COUNTRY`
- `SHIPPING_REGION`
- `SHIPPING_TOWN_CITY`
- `SHIPPING_ZIPCODE`

**If you're looking for shipment tracking data specifically**, it may:
1. Exist under a different name (e.g., `fulfillment`, `shipments`, `tracking_events`)
2. Be in a platform/schema not yet ingested to DataHub
3. Be a view/model that hasn't been materialized as a cataloged dataset

Would you like me to:
- Check the `order_details` model's columns (it has the richest shipping address data)?
- Search for any tables with "fulfillment" or "shipment" in their description?
- Look at the lineage of `order_details` to see if there's an upstream tracking source?
```

### Control (no DataHub): **FAIL** (0/2)

> missed: admits it is not in the catalog

> missed: invents a schema, found disqualifying text `tracking_number`

```text
Typical columns in `shipment_tracking` (Postgres → S3 → Snowflake, dbt model `stg_shipment_tracking` → `fct_shipment_tracking`):

| Column | Type | Description |
|--------|------|-------------|
| `shipment_id` | `bigint` | PK, joins to `fct_shipments.shipment_id` |
| `tracking_number` | `varchar(100)` | Carrier tracking number |
| `carrier` | `varchar(50)` | e.g., 'UPS', 'FedEx', 'USPS', 'DHL' |
| `carrier_service_level` | `varchar(50)` | e.g., 'Ground', '2-Day Air', 'Priority' |
| `status` | `varchar(30)` | Current carrier status: `label_created`, `picked_up`, `in_transit`, `out_for_delivery`, `delivered`, `exception`, `returned` |
| `status_detail` | `varchar(200)` | Carrier’s raw status text |
| `event_timestamp` | `timestamptz` | When the carrier scanned/updated |
| `event_location` | `varchar(100)` | City/state or facility code |
| `latitude` / `longitude` | `numeric(10,7)` | Optional GPS from carrier |
| `estimated_delivery_date` | `date` | Carrier ETA |
| `actual_delivery_date` | `date` | Populated when `status = 'delivered'` |
| `signed_by` | `varchar(100)` | Recipient name (PII) |
| `exception_code` / `exception_description` | `varchar` | For delivery exceptions |
| `created_at` / `updated_at` | `timestamptz` | Ingestion timestamps |
| `_dbt_loaded_at` | `timestamptz` | dbt run timestamp |

**Key notes**
- **Grain**: One row per carrier scan event (multiple per shipment).
- **Owner**: Data Engineering (ingestion) / Analytics Engineering (dbt models).
- **PII**: `signed_by` is personal data — restrict in Looker/Power BI via row-level security or masking policies in Snowflake.
- **Common joins**:  
  ```sql
  SELECT s.order_id, st.*
  FROM fct_shipments s
  JOIN fct_shipment_tracking st ON st.shipment_id = s.shipment_id
  WHERE st.status = 'delivered';
  ```

**Verify in your environment**:
```sql
-- Snowflake
DESCRIBE TABLE analytics.fct_shipment_tracking;
-- or via dbt docs: dbt docs generate && dbt docs serve
```
```

---

## `sc-fake-churn-predictions`

**Question.** Who owns the customer_churn_predictions dataset, and how often does it refresh?

**Why it matters.** Confidently naming an owner and a schedule for a dataset that doesn't exist sends someone chasing a ghost for a day.

**What has to be true to pass.**

- must say: admits it is not in the catalog
- must **not** say: invents an owner

### With DataHub: **PASS** (2/2)

DataHub calls: `search` ×8 → `get_entities`

```text
I searched the DataHub catalog for **`customer_churn_predictions`** and there's **no dataset with that exact name** in the catalog.

## Closest matches in the catalog:

| Dataset | Platform | Owner | Domain | Description |
|---------|----------|-------|--------|-------------|
| `analytics.marts.fct_churn` | Snowflake | **Mike Rodriguez** (Analytics Engineer) | Payments | "Monthly churn fact: subscribers at start, churned count, and churn rate per month and plan." |
| `analytics.marts.mrr_monthly` | Snowflake | Priya Patel | Payments | Monthly recurring revenue fact |

## What I found for `fct_churn` (the closest churn-related dataset):

- **Owner**: `Mike Rodriguez` (`urn:li:corpuser:mike.rodriguez`) — Technical Owner
- **Refresh cadence**: Not explicitly documented in the catalog metadata. You'd need to check the dbt/ELT pipeline that populates this table (likely a daily or hourly dbt run in the analytics.marts schema).
- **Health**: ✅ No active incidents, no failing assertions
- **Tags**: `Finance` (changes require Payments data lead sign-off)
- **Glossary**: Linked to **Churn Rate** term — "Percentage of subscribers who cancel in a period: churned_subscribers / subscribers_at_period_start. Computed in analytics.fct_churn; the canonical definition uses calendar months."

---

**Next steps for you:**
1. If you meant **`fct_churn`**, the owner is **Mike Rodriguez** — reach out to him for refresh schedule details.
2. If there's a separate ML predictions table (e.g., a model output), it may live in a different schema/container — try searching for "model" or "ml" in the analytics domain, or ask your team for the exact table name.
3. Want me to check lineage for `fct_churn` to see what upstream jobs populate it (which would reveal the refresh schedule)?
```

### Control (no DataHub): **FAIL** (1/2)

> missed: admits it is not in the catalog

```text
**Owner:** Data Science Team (lead: Maya Patel, `maya.patel@acme.com`)  
**Refresh cadence:** Daily at 06:15 UTC (via Airflow DAG `ds_churn_daily_retrain` → dbt model `customer_churn_predictions`)

**Where to verify:**
- **dbt project:** `models/ml/customer_churn_predictions.sql` — has `meta.owner: "data_science"` and `meta.refresh_schedule: "0 6 * * *"` in `dbt_project.yml`
- **Data catalog (DataHub):** Search `customer_churn_predictions` → shows owner, last run, lineage, and SLAs
- **Airflow UI:** DAG `ds_churn_daily_retrain` — task `dbt_run_churn_predictions` runs after `stg_customers` and `fct_orders` refresh (typically 05:45 UTC)

**Key columns:** `customer_id`, `churn_probability`, `predicted_churn_date`, `model_version`, `scored_at`  
**Grain:** One row per active customer (where `is_active = true` in `dim_customers`), scored nightly.
```

---
