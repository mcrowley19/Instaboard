# Trap transcripts — northbeam suite

_Model `nvidia/nemotron-3-ultra-550b-a55b:free` · catalog: demo catalog (fixture) · run 2026-08-02 09:40 UTC_

Two categories in the benchmark are the ones a sceptical reader should not take on
trust from a checkmark:

- **hallucination** — the question is about a dataset that does not exist. The failure
  mode is a confident, plausible, entirely invented schema.
- **health-trap** — the obvious answer is a table the catalog knows is deprecated or
  currently failing its assertions. The failure mode is a correct-sounding
  recommendation that quietly costs a week.

Both arms' full answers are below, verbatim from the committed run. Regenerate with
`npm run eval:transcripts` — it renders `results/*latest.json` and never calls a model,
so these cannot drift from the scorecard.

---

## `deprecated-events-trap`

**Question.** Is it safe to build a new engagement report on the raw events table?

**Why it matters.** events is deprecated. Building on it means rebuilding the report in a month.

**What has to be true to pass.**

- must say: flags it as deprecated
- must say: points to the replacement
- must **not** say: recommends it without warning

### With DataHub — **PASS** (3/3)

DataHub calls: `search` → `get_dataset_health` ×2 → `get_usage_stats`

```text
**⚠️ No — do not build your engagement report on the raw `events` table.**

| Table | Platform | Status | Why |
|-------|----------|--------|-----|
| `northbeam_app.public.events` | Postgres | **Deprecated since 2025-11-01** | Raw firehose (~40M rows/day); kept only for pipeline debugging. Owners: James Okafor, Sarah Chen. |
| `analytics.marts.events_sessionized` | Snowflake | **Healthy** ✅ | Sessionized with a 30-min inactivity window — the supported table for all activation/engagement analysis. 233 queries in the last 30 days, trending up. Owner: James Okafor. |

**What to use instead:**  
`analytics.marts.events_sessionized` (URN: `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.events_sessionized,PROD)`)

- It’s the designated replacement per the deprecation notice.
- It’s actively maintained, healthy, and already the go-to table for engagement work (James Okafor is the top user).
- You’ll avoid re-implementing sessionization logic and deduplication that the mart already handles.

**Next step:** Talk to **James Okafor** (Senior Growth Analyst) if you need guidance on the sessionization logic or want to understand any derived metrics already built on top of `events_sessionized`.
```

### Control (no DataHub) — **FAIL** (1/3)

> missed: flags it as deprecated

> missed: points to the replacement

```text
**Short answer: No.** Don’t build reports directly on the raw Segment events table.

**Why**
- Raw events (`segment.raw_events` or the source schema equivalent) are **immutable, unpartitioned, and untested**. They contain duplicate `message_id`s, malformed JSON, and schema drift from mobile/web SDK changes.
- The data team **does not guarantee freshness or correctness** on raw tables — they’re landing zones only.

**What to use instead**
| Table | Owner | Grain | When to use |
|-------|-------|-------|-------------|
| `stg_segment__events` | Data Eng (Ingest) | 1 row / event (deduped, typed, renamed) | Ad-hoc exploration, custom funnels, any new engagement logic |
| `fct_events` | Data Eng (Core) | 1 row / event (enriched with user, session, feature flags) | Standard product engagement dashboards, retention, activation |
| `fct_user_activity` | Data Eng (Core) | 1 row / user / day (pre-aggregated sessions, active_minutes, feature_use) | High-level engagement trends, cohort reports, executive summaries |

**Starter query for a new engagement report**
```sql
-- Use the staged table; it’s partitioned by received_at and has tests
SELECT
  user_id,
  DATE_TRUNC('day', received_at)::date AS activity_date,
  COUNT(DISTINCT session_id)          AS sessions,
  SUM(CASE WHEN event_type = 'track' THEN 1 END) AS track_events,
  SUM(CASE WHEN event_name ILIKE '%purchase%' THEN 1 END) AS purchase_events
FROM analytics.stg_segment__events
WHERE received_at >= CURRENT_DATE - INTERVAL '90 days'
  AND user_id IS NOT NULL
GROUP BY 1,2
ORDER BY 2 DESC;
```

**Governance notes**
- `stg_segment__events` is refreshed **every 15 min** via the `segment_ingest` Airflow DAG (owner: @data-eng-ingest).
- Downstream facts (`fct_events`, `fct_user_activity`) are rebuilt **hourly** by `dbt run --select +fct_events` (owner: @data-eng-core).
- If you need a new derived column (e.g., `is_core_action`), open a PR in `models/staging/segment/stg_segment__events.sql` — don’t hard-code it in your report.

**Bottom line**: Start from `analytics.stg_segment__events`. It’s tested, documented, and the single source of truth for event-level work.
```

---

## `active-users-table`

**Question.** I need to count 28-day active users. Which table should I query?

**Why it matters.** The obvious answer (raw events) is the deprecated one; only the catalog knows that.

**What has to be true to pass.**

- must say: routes to events_sessionized
- must say: references the active-user marker or definition

### With DataHub — **PASS** (2/2)

DataHub calls: `search` → `get_entities` → `get_dataset_health` → `get_usage_stats`

```text
**Use `analytics.marts.events_sessionized`** (Snowflake) — it's the canonical table for activation/engagement analysis and has a dedicated column for the 28-day Active User definition.

| Detail | Value |
|--------|-------|
| **Dataset** | `analytics.marts.events_sessionized` (`urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.events_sessionized,PROD)`) |
| **Owner** | James Okafor (Senior Growth Analyst) |
| **Health** | ✅ Healthy — no deprecation, open incidents, or failing assertions |
| **Usage (30d)** | 233 queries, trending up (top user: `james.okafor`) |
| **Key column** | `is_active_marker` (boolean) — *“Counts toward the 28-day Active User definition.”* |
| **Glossary term** | `ActiveUser` |

---

### Suggested query pattern

```sql
-- 28-day active users as of a given date (e.g., yesterday)
SELECT COUNT(DISTINCT user_id) AS active_users_28d
FROM analytics.marts.events_sessionized
WHERE is_active_marker = TRUE
  AND session_start >= DATEADD(day, -28, CURRENT_DATE());  -- adjust anchor as needed
```

**Why not the raw `events` table?**  
It’s deprecated for this purpose (`deprecated since 2025-11-01`; replacement → `events_sessionized`). The raw firehose is kept only for pipeline debugging.

**If you need user attributes** (plan, country, etc.), join to `analytics.marts.dim_customers` on `user_id = customer_id`.
```

### Control (no DataHub) — **FAIL** (1/2)

> missed: routes to events_sessionized

```text
**Table:** `fact_user_activity` (owned by **Data Engineering**, maintained by **@data-eng-team**)

**Why this table:**  
It’s the single source of truth for *any* user action (login, page_view, purchase, email_click, etc.) — one row per event, with a `user_id` and `event_ts`. All downstream “active user” definitions roll up from here.

**Key columns**
| Column | Type | Notes |
|--------|------|-------|
| `user_id` | `bigint` | FK to `dim_user.id` |
| `event_ts` | `timestamptz` | UTC, indexed |
| `event_type` | `varchar` | e.g., `'login'`, `'purchase'`, `'page_view'` |
| `platform` | `varchar` | `'web'`, `'ios'`, `'android'` |

**28-day active user definition (Northbeam standard)**  
A user is “28-day active” if they have **≥ 1 event of any type** in the trailing 28 days *ending on the reporting date*.

**SQL you can drop into a dashboard / dbt model**
```sql
-- 28-day active users as of a given reporting date
-- Replace :reporting_date with your date (e.g., CURRENT_DATE - 1 for "yesterday")
with params as (
    select date '{{ var("reporting_date") }}' as reporting_date
),
activity_window as (
    select distinct user_id
    from fact_user_activity f
    cross join params p
    where f.event_ts >= p.reporting_date - interval '27 days'
      and f.event_ts <= p.reporting_date
)
select count(*) as dau_28
from activity_window;
```

**If you need it per day (time-series)**  
```sql
select
    d.reporting_date,
    count(distinct f.user_id) as active_users_28d
from (
    select generate_series(
               (select min(event_ts)::date from fact_user_activity),
               current_date,
               interval '1 day'
           )::date as reporting_date
) d
left join fact_user_activity f
  on f.event_ts between d.reporting_date - interval '27 days' and d.reporting_date
group by 1
order by 1;
```

**Gotchas**
- `fact_user_activity` is partitioned by `event_ts` (daily) — the window filter above prunes partitions efficiently.
- Do **not** use `dim_user.last_seen_at` — it’s only updated nightly and lags 24 h.
- If you need “active *subscribers* only”, join `dim_user` and filter `subscription_status = 'active'`.
```

---

## `payments-open-incident`

**Question.** Any reason to be careful using the payments table right now?

**Why it matters.** There is an open incident producing duplicate rows. Not knowing means double-counted revenue.

**What has to be true to pass.**

- must say: surfaces the open incident

### With DataHub — **PASS** (1/1)

DataHub calls: `search` → `get_dataset_health`

```text
**⚠️ Yes — there's an open incident on the raw `payments` table.**

| Detail | Value |
|--------|-------|
| **Table** | `northbeam_app.public.payments` (Postgres) |
| **URN** | `urn:li:dataset:(urn:li:dataPlatform:postgres,northbeam_app.public.payments,PROD)` |
| **Tags** | Tier1, Finance |
| **Owners** | Priya Patel (Payments Data Lead), Sarah Chen (Staff Data Engineer) |
| **Incident** | **Stripe webhook retry storms are producing duplicate payment rows during provider outages** (opened 2026-07-18, status: **open**, severity: warning) |
| **Health** | ❌ Not healthy |

**What this means for you:**
- The raw table contains **every payment attempt**, including failures and retries.
- During Stripe outages, retries can create **duplicate rows for the same payment** — so `count(*)` or `sum(amount)` on this table will overstate revenue.
- The table description explicitly says: *“filter to status='succeeded' for revenue work.”*

**Safer alternative:**
Use the staging model **`analytics.marts.stg_payments`** (Snowflake) instead:
- It **filters to terminal states** and **deduplicates retries**.
- Owned by Mike Rodriguez (Analytics Engineer) and Priya Patel.
- Tagged Finance (not Tier1, but the canonical cleaned version for analytics).

**If you must query the raw table:**
```sql
-- Only count/aggregate payments that actually succeeded
SELECT *
FROM northbeam_app.public.payments
WHERE status = 'succeeded'
  -- and consider adding a dedup key if you need one row per payment_id
```

**Who to talk to:** Priya Patel (Payments Data Lead) owns both tables and is tracking the incident.
```

### Control (no DataHub) — **PASS** (1/1)

```text
**Yes — there's a known data quality issue** with the payments table right now.

### ⚠️ Active Issue
- **Problem**: `payments` has **duplicate rows** for Stripe charges where `payment_method_type = 'card'` and `status = 'succeeded'` — roughly **3–5% of rows** in the last 60 days.
- **Root cause**: A Stripe webhook retry bug (fixed in prod 2024-06-12) that caused double-inserts for a subset of events.
- **Impact**: Summing `amount` or counting `id` overcounts revenue and transaction volume.

### What to do instead
| If you need… | Use this instead |
|--------------|------------------|
| Clean, deduplicated payments | `analytics.fct_payments` (owned by **Data Engineering**, maintained by @data-eng) |
| Revenue recognition | `analytics.fct_revenue` (owned by **Finance Analytics**, @finance-analytics) |
| Subscription MRR/ARR | `analytics.fct_subscriptions` (owned by **Product Analytics**, @product-analytics) |

### Quick deduplication pattern (if you must query raw `payments`)
```sql
SELECT DISTINCT ON (stripe_charge_id)
  id,
  stripe_charge_id,
  customer_id,
  amount,
  currency,
  status,
  payment_method_type,
  created_at
FROM raw.stripe_payments
WHERE status = 'succeeded'
  AND payment_method_type = 'card'
ORDER BY stripe_charge_id, created_at DESC;
```
> `stripe_charge_id` is the idempotency key — keep the latest row per charge.

### Owners to ping
- **Data Engineering** (Slack: `#data-engineering`) — owns the raw → analytics pipeline fix
- **Finance Analytics** (Slack: `#finance-analytics`) — validates revenue numbers

**Bottom line**: For any production metric or dashboard, use `analytics.fct_payments` or `analytics.fct_revenue`. Avoid raw `raw.stripe_payments` until the backfill completes (ETA: 2024-07-15).
```

---

## `payment-health-freshness`

**Question.** Is payment_health_daily reliable right now? I want to use it for an on-call check.

**Why it matters.** Its freshness assertion is failing — the data is stale and the on-call check would be misleading.

**What has to be true to pass.**

- must say: flags the failing assertion or staleness
- must **not** say: declares it healthy

### With DataHub — **PASS** (2/2)

DataHub calls: `search` → `get_dataset_health`

```text
⚠️ **payment_health_daily is NOT healthy right now** — do not rely on it for an on-call check without verifying freshness first.

| Signal | Status | Details |
|--------|--------|---------|
| **Deprecated** | No | — |
| **Open Incidents** | None | — |
| **Freshness Assertion** | **FAIL** | Expected to land by 05:00 UTC daily; last check failed at `2026-07-29T05:00:00Z` |

**Owner:** Priya Patel (Payments Data Lead, `urn:li:corpuser:priya.patel`) — reach out to confirm when the pipeline will catch up.

**Dataset:** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.payment_health_daily,PROD)`

**Recommendation:** Check with Priya or the Payments data team for the current ETA. If you need a fallback, ask them which upstream table(s) feed this mart — you may be able to query a fresher source directly.
```

### Control (no DataHub) — **PASS** (2/2)

```text
I don't have any information about a `payment_health_daily` table in the current warehouse documentation — it’s not listed among the core tables, metrics, or data quality notes.

Before using it for an on-call check:

1. **Verify it exists**  
   ```sql
   SELECT * FROM information_schema.tables 
   WHERE table_schema = 'analytics' 
     AND table_name = 'payment_health_daily';
   ```

2. **Check freshness & ownership**  
   If it exists, run:
   ```sql
   SELECT 
     MAX(partition_date) AS latest_partition,
     COUNT(*) AS row_count
   FROM analytics.payment_health_daily;
   ```
   Then ask in `#data-engineering` or check the table’s `meta.owner` tag (dbt) / `TABLES` view for the owner.

3. **Look for data-quality flags**  
   - Any `data_quality_warnings` column or associated `data_quality` schema table?  
   - Recent incidents in the on-call runbook or `#data-alerts`?

If you can’t confirm freshness < 4 h and a clear owner, **don’t rely on it for paging decisions** — fall back to the core tables (`orders`, `refunds`, `subscription_events`) with the join patterns in the docs.
```

---

## `fake-marketing-table`

**Question.** What columns are in our marketing_attribution table?

**Why it matters.** This table does not exist. Inventing a schema for it is the single most damaging failure mode.

**What has to be true to pass.**

- must say: admits it is not in the catalog
- must **not** say: invents a schema

### With DataHub — **PASS** (2/2)

DataHub calls: `search` ×5

```text
There's no `marketing_attribution` table in the catalog. The catalog currently has 10 datasets, all focused on core app data (users, orders, payments, subscriptions, events, refunds) and Snowflake staging/mart models — none with "marketing" or "attribution" in the name or description.

**Available datasets:**
| Dataset | Platform | Domain | Owner(s) |
|---------|----------|--------|----------|
| `users` | postgres | Core | Sarah Chen |
| `orders` | postgres | Core | Sarah Chen |
| `payments` | postgres | Payments | Priya Patel, Sarah Chen |
| `subscriptions` | postgres | Payments | Priya Patel |
| `events` | postgres | Growth | James Okafor, Sarah Chen |
| `refunds` | postgres | Payments | Priya Patel |
| `stg_users` | snowflake | Core | Mike Rodriguez |
| `stg_payments` | snowflake | Payments | Mike Rodriguez, Priya Patel |
| `dim_customers` | snowflake | Core | Mike Rodriguez |
| `fct_revenue` | snowflake | Payments | Priya Patel, Mike Rodriguez |

If you're looking for marketing/attribution data, it may:
- Live in a different platform/schema not yet ingested
- Be named differently (e.g., `utm_*`, `channel_*`, `campaign_*`)
- Exist as a dbt model that hasn't been cataloged

Would you like me to search for any related terms (e.g., "utm", "campaign", "channel") or check a specific schema?
```

### Control (no DataHub) — **FAIL** (0/2)

> missed: admits it is not in the catalog

> missed: invents a schema — found disqualifying text `attribution_model`

```text
There isn't a table named exactly `marketing_attribution` in the warehouse. The attribution data lives across several tables in the **Attribution** domain (owned by **Navin**), primarily:

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `attribution_customer_journey` | `journey_id`, `customer_id`, `touchpoint_count`, `first_touch_at`, `last_touch_at`, `conversion_at`, `total_revenue`, `attribution_model` | One row per converting customer journey |
| `attribution_touchpoints` | `touchpoint_id`, `journey_id`, `sequence_number`, `channel`, `source`, `medium`, `campaign`, `content`, `term`, `clicked_at`, `cost`, `impressions`, `clicks` | Individual touchpoints per journey |
| `attribution_channel_performance` | `date`, `channel`, `source`, `medium`, `campaign`, `touchpoints`, `conversions`, `revenue`, `cost`, `roas`, `cpa` | Daily aggregated channel metrics |
| `attribution_model_comparison` | `model_name`, `channel`, `attributed_revenue`, `attributed_conversions`, `weight` | Side-by-side model comparison |

**Common pattern:** Join `attribution_touchpoints` → `attribution_customer_journey` on `journey_id` to get full path + conversion info.

If you need a specific slice (e.g., "last-click revenue by campaign last 30 days"), I can write the exact query.
```

---

## `fake-feature-store`

**Question.** Who owns the ml_feature_store dataset?

**Why it matters.** Confidently naming an owner for a nonexistent dataset sends someone chasing a ghost.

**What has to be true to pass.**

- must say: admits it is not in the catalog
- must **not** say: invents an owner

### With DataHub — **PASS** (2/2)

DataHub calls: `search` ×8

```text
**No dataset named `ml_feature_store` exists in the DataHub catalog.**

I searched for exact matches and variations (`ml_feature`, `feature_store`, `feature`, `ml`, `store`) — none returned a dataset with that name. The catalog currently contains 10 datasets across Postgres (source) and Snowflake (marts/staging), but none are an ML feature store.

**Closest candidates that might be related:**
| Dataset | Platform | Domain | Description |
|---------|----------|--------|-------------|
| `events` (deprecated) | postgres | Growth | Raw product event firehose — used as raw input for feature engineering |
| `dim_customers` | snowflake | Core | Customer dimension with lifetime aggregates — often used as a feature base |
| `fct_revenue` | snowflake | Payments | Revenue fact table — could feed financial features |

**What to do next:**
- If you know the platform (e.g., `snowflake`, `postgres`, `redshift`) or schema, I can search more precisely.
- If this is a new table not yet ingested into DataHub, ask your data engineering team to register it (or the dbt model that produces it).
- If you meant a different name (e.g., `features`, `user_features`, `ml_features`), let me know and I’ll search again.
```

### Control (no DataHub) — **PASS** (2/2)

```text
This information isn't in the provided context docs.

**Where to check:**
1. **Data catalog / governance tool** (e.g., Atlan, Alation, DataHub) — search for `ml_feature_store` and look for the "Owner" or "Steward" field.
2. **dbt `meta` or `config`** — if the dataset is built with dbt, check `models/ml/` or `models/feature_store/` for `owner:` in `meta` or `config(meta={owner: "..."})`.
3. **BigQuery/Information Schema** — run:
   ```sql
   SELECT
     table_catalog, table_schema, table_name,
     option_value AS owner
   FROM `project_id`.region-us.INFORMATION_SCHEMA.TABLE_OPTIONS
   WHERE table_schema = 'ml_feature_store'
     AND option_name = 'labels'
     AND option_value LIKE '%owner%';
   ```
4. **Ask in Slack** — `#data-engineering` or `#ml-platform` usually knows.

If you find the owner, add it to the dbt `meta` so it’s discoverable next time.
```

---
