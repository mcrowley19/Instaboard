/**
 * Fixture catalog for demo mode — the same "Northbeam" subscription-commerce
 * company that scripts/seed_datahub.py loads into a real DataHub instance.
 * Keep the two in sync so demo mode and a seeded live instance tell the
 * same story.
 */

export interface DemoField {
  fieldPath: string;
  nativeDataType: string;
  description: string;
  pii?: boolean;
  terms?: string[];
}

export interface DemoDeprecation {
  since: string;
  reason: string;
  replacement?: string;
}

export interface DemoIncident {
  severity: "critical" | "warning";
  title: string;
  openedAt: string;
  status: "open" | "resolved";
}

export interface DemoAssertion {
  type: "freshness" | "volume";
  description: string;
  status: "pass" | "fail";
  lastCheckedAt: string;
}

export interface DemoUsage {
  queryCount30d: number;
  topUsers: string[];
  trend: "up" | "down" | "flat";
}

export interface DemoDataset {
  urn: string;
  name: string;
  platform: "postgres" | "snowflake";
  description: string;
  domain: string;
  owners: string[];
  tags: string[];
  terms: string[];
  fields: DemoField[];
  deprecated?: DemoDeprecation;
  incidents?: DemoIncident[];
  assertions?: DemoAssertion[];
  usage?: DemoUsage;
}

export interface DemoQuery {
  id: string;
  name: string;
  description: string;
  sql: string;
  subjects: string[];
}

export const DEMO_USERS: Record<string, { name: string; title: string; email: string }> = {
  "sarah.chen": { name: "Sarah Chen", title: "Staff Data Engineer", email: "sarah.chen@northbeam.io" },
  "mike.rodriguez": { name: "Mike Rodriguez", title: "Analytics Engineer", email: "mike.rodriguez@northbeam.io" },
  "priya.patel": { name: "Priya Patel", title: "Payments Data Lead", email: "priya.patel@northbeam.io" },
  "james.okafor": { name: "James Okafor", title: "Senior Growth Analyst", email: "james.okafor@northbeam.io" },
};

export const DEMO_TAGS: Record<string, string> = {
  PII: "Contains personally identifiable information. Access is audited; never export to third parties.",
  Tier1: "Business-critical dataset. Breakage pages the on-call data engineer.",
  Deprecated: "Scheduled for removal. Do not build new dependencies on this.",
  Finance: "Used in financial reporting. Changes require sign-off from the Payments data lead.",
};

export const DEMO_TERMS: Record<string, { name: string; definition: string; related?: string[] }> = {
  MRR: {
    name: "Monthly Recurring Revenue",
    definition:
      "Sum of all active subscription amounts normalized to a monthly value. Computed in analytics.mrr_monthly from fct_revenue, excluding one-time fees and refunds. Annual plans are divided by 12.",
    related: ["ARR", "ChurnRate", "GMV"],
  },
  ARR: {
    name: "Annual Recurring Revenue",
    definition: "MRR × 12. Reported to the board monthly; sourced from analytics.mrr_monthly.",
    related: ["MRR"],
  },
  ChurnRate: {
    name: "Churn Rate",
    definition:
      "Percentage of subscribers who cancel in a period: churned_subscribers / subscribers_at_period_start. Computed in analytics.fct_churn; the canonical definition uses calendar months.",
    related: ["MRR"],
  },
  GMV: {
    name: "Gross Merchandise Value",
    definition: "Total value of orders before refunds, fees, and discounts. Sourced from app orders.",
    related: ["MRR"],
  },
  ActiveUser: {
    name: "Active User",
    definition: "A user with at least one product event in the trailing 28 days (see analytics.events_sessionized).",
    related: [],
  },
};

export const DEMO_DOMAINS: Record<string, string> = {
  Payments: "Billing, payment processing, revenue and finance reporting.",
  Growth: "Product analytics, activation, retention and experimentation.",
  Core: "Source-of-truth application data owned by data engineering.",
};

export function pgUrn(table: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:postgres,northbeam_app.public.${table},PROD)`;
}

export function sfUrn(table: string): string {
  return `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.${table},PROD)`;
}

export const DEMO_DATASETS: DemoDataset[] = [
  {
    urn: pgUrn("users"),
    name: "users",
    platform: "postgres",
    description:
      "Source-of-truth user accounts from the production app. One row per registered user. Synced to Snowflake hourly via Fivetran.",
    domain: "Core",
    owners: ["sarah.chen"],
    tags: ["Tier1"],
    terms: [],
    usage: { queryCount30d: 412, topUsers: ["mike.rodriguez", "james.okafor"], trend: "flat" },
    fields: [
      { fieldPath: "id", nativeDataType: "bigint", description: "Primary key. Referenced everywhere as user_id / customer_id." },
      { fieldPath: "email", nativeDataType: "varchar", description: "Login email. Unique. Used for billing receipts and lifecycle emails.", pii: true },
      { fieldPath: "full_name", nativeDataType: "varchar", description: "Display name entered at signup.", pii: true },
      { fieldPath: "country", nativeDataType: "varchar", description: "ISO-3166 country code, from billing address." },
      { fieldPath: "plan", nativeDataType: "varchar", description: "Current plan slug: free | starter | pro | enterprise." },
      { fieldPath: "created_at", nativeDataType: "timestamp", description: "Signup timestamp (UTC)." },
    ],
  },
  {
    urn: pgUrn("orders"),
    name: "orders",
    platform: "postgres",
    description: "One row per checkout. Includes one-time purchases and the initial order of a subscription.",
    domain: "Core",
    owners: ["sarah.chen"],
    tags: ["Tier1"],
    terms: ["GMV"],
    usage: { queryCount30d: 268, topUsers: ["mike.rodriguez"], trend: "flat" },
    fields: [
      { fieldPath: "id", nativeDataType: "bigint", description: "Primary key." },
      { fieldPath: "user_id", nativeDataType: "bigint", description: "FK → users.id." },
      { fieldPath: "total_amount", nativeDataType: "numeric(12,2)", description: "Order total in USD, pre-refund.", terms: ["GMV"] },
      { fieldPath: "status", nativeDataType: "varchar", description: "pending | paid | cancelled | refunded." },
      { fieldPath: "created_at", nativeDataType: "timestamp", description: "Checkout timestamp (UTC)." },
    ],
  },
  {
    urn: pgUrn("payments"),
    name: "payments",
    platform: "postgres",
    description:
      "Raw payment attempts from the Stripe webhook consumer. Includes failures and retries — filter to status='succeeded' for revenue work.",
    domain: "Payments",
    owners: ["priya.patel", "sarah.chen"],
    tags: ["Tier1", "Finance"],
    terms: [],
    incidents: [
      {
        severity: "warning",
        title: "Stripe webhook retry storms are producing duplicate payment rows during provider outages",
        openedAt: "2026-07-18",
        status: "open",
      },
    ],
    usage: { queryCount30d: 356, topUsers: ["priya.patel", "mike.rodriguez"], trend: "flat" },
    fields: [
      { fieldPath: "id", nativeDataType: "bigint", description: "Primary key." },
      { fieldPath: "order_id", nativeDataType: "bigint", description: "FK → orders.id." },
      { fieldPath: "user_id", nativeDataType: "bigint", description: "FK → users.id." },
      { fieldPath: "amount", nativeDataType: "numeric(12,2)", description: "Charged amount in USD." },
      { fieldPath: "status", nativeDataType: "varchar", description: "succeeded | failed | pending | disputed." },
      { fieldPath: "provider", nativeDataType: "varchar", description: "stripe | paypal." },
      { fieldPath: "card_last4", nativeDataType: "varchar", description: "Last 4 digits of the card.", pii: true },
      { fieldPath: "created_at", nativeDataType: "timestamp", description: "Attempt timestamp (UTC)." },
    ],
  },
  {
    urn: pgUrn("subscriptions"),
    name: "subscriptions",
    platform: "postgres",
    description: "Subscription lifecycle table. One row per subscription; status transitions drive churn metrics.",
    domain: "Payments",
    owners: ["priya.patel"],
    tags: ["Tier1", "Finance"],
    terms: ["MRR", "ChurnRate"],
    usage: { queryCount30d: 301, topUsers: ["priya.patel", "mike.rodriguez"], trend: "up" },
    fields: [
      { fieldPath: "id", nativeDataType: "bigint", description: "Primary key." },
      { fieldPath: "user_id", nativeDataType: "bigint", description: "FK → users.id." },
      { fieldPath: "plan", nativeDataType: "varchar", description: "Plan slug at the current term." },
      { fieldPath: "monthly_amount", nativeDataType: "numeric(12,2)", description: "Normalized monthly price in USD.", terms: ["MRR"] },
      { fieldPath: "status", nativeDataType: "varchar", description: "trialing | active | past_due | cancelled." },
      { fieldPath: "started_at", nativeDataType: "timestamp", description: "Subscription start." },
      { fieldPath: "cancelled_at", nativeDataType: "timestamp", description: "Cancellation timestamp, null while active.", terms: ["ChurnRate"] },
    ],
  },
  {
    urn: pgUrn("events"),
    name: "events",
    platform: "postgres",
    description:
      "Product event firehose from the web and mobile clients (Segment). ~40M rows/day; query the sessionized mart instead of this raw table where possible.",
    domain: "Growth",
    owners: ["james.okafor", "sarah.chen"],
    tags: [],
    terms: ["ActiveUser"],
    deprecated: {
      since: "2025-11-01",
      reason: "Superseded by events_sessionized for all activation/engagement analysis — this raw firehose is kept only for pipeline debugging.",
      replacement: sfUrn("events_sessionized"),
    },
    usage: { queryCount30d: 74, topUsers: ["james.okafor"], trend: "down" },
    fields: [
      { fieldPath: "event_id", nativeDataType: "uuid", description: "Unique event id." },
      { fieldPath: "user_id", nativeDataType: "bigint", description: "FK → users.id; null for anonymous traffic." },
      { fieldPath: "event_name", nativeDataType: "varchar", description: "e.g. page_view, checkout_started, feature_used." },
      { fieldPath: "properties", nativeDataType: "jsonb", description: "Free-form event payload." },
      { fieldPath: "occurred_at", nativeDataType: "timestamp", description: "Client-side event timestamp (UTC)." },
    ],
  },
  {
    urn: pgUrn("refunds"),
    name: "refunds",
    platform: "postgres",
    description: "Refunds issued against payments. Joined into fct_revenue to compute net revenue.",
    domain: "Payments",
    owners: ["priya.patel"],
    tags: ["Finance"],
    terms: [],
    usage: { queryCount30d: 58, topUsers: ["priya.patel"], trend: "flat" },
    fields: [
      { fieldPath: "id", nativeDataType: "bigint", description: "Primary key." },
      { fieldPath: "payment_id", nativeDataType: "bigint", description: "FK → payments.id." },
      { fieldPath: "amount", nativeDataType: "numeric(12,2)", description: "Refunded amount in USD." },
      { fieldPath: "reason", nativeDataType: "varchar", description: "requested_by_customer | fraud | duplicate." },
      { fieldPath: "created_at", nativeDataType: "timestamp", description: "Refund timestamp (UTC)." },
    ],
  },
  {
    urn: sfUrn("stg_users"),
    name: "stg_users",
    platform: "snowflake",
    description:
      "Staging model over app users: renames, type casts, and email-domain extraction. Materialized hourly by dbt (northbeam_dbt.staging).",
    domain: "Core",
    owners: ["mike.rodriguez"],
    tags: [],
    terms: [],
    usage: { queryCount30d: 22, topUsers: ["mike.rodriguez"], trend: "flat" },
    fields: [
      { fieldPath: "user_id", nativeDataType: "number", description: "users.id passthrough." },
      { fieldPath: "email", nativeDataType: "varchar", description: "Lowercased login email.", pii: true },
      { fieldPath: "email_domain", nativeDataType: "varchar", description: "Domain part of email — used for B2B account grouping." },
      { fieldPath: "country", nativeDataType: "varchar", description: "ISO country code." },
      { fieldPath: "plan", nativeDataType: "varchar", description: "Current plan slug." },
      { fieldPath: "signed_up_at", nativeDataType: "timestamp_ntz", description: "Signup timestamp." },
    ],
  },
  {
    urn: sfUrn("stg_payments"),
    name: "stg_payments",
    platform: "snowflake",
    description: "Staging model over raw payments: filters to terminal states and deduplicates retries.",
    domain: "Payments",
    owners: ["mike.rodriguez", "priya.patel"],
    tags: ["Finance"],
    terms: [],
    usage: { queryCount30d: 19, topUsers: ["mike.rodriguez"], trend: "flat" },
    fields: [
      { fieldPath: "payment_id", nativeDataType: "number", description: "payments.id passthrough." },
      { fieldPath: "order_id", nativeDataType: "number", description: "FK → orders.id." },
      { fieldPath: "user_id", nativeDataType: "number", description: "FK → users.id." },
      { fieldPath: "amount_usd", nativeDataType: "number(12,2)", description: "Charged amount in USD." },
      { fieldPath: "is_successful", nativeDataType: "boolean", description: "True when status = succeeded." },
      { fieldPath: "paid_at", nativeDataType: "timestamp_ntz", description: "Settlement timestamp." },
    ],
  },
  {
    urn: sfUrn("dim_customers"),
    name: "dim_customers",
    platform: "snowflake",
    description: "Customer dimension: one row per user with lifetime aggregates. The join key for almost every mart.",
    domain: "Core",
    owners: ["mike.rodriguez"],
    tags: ["Tier1"],
    terms: [],
    usage: { queryCount30d: 587, topUsers: ["mike.rodriguez", "priya.patel", "james.okafor"], trend: "up" },
    fields: [
      { fieldPath: "customer_id", nativeDataType: "number", description: "= users.id. Canonical customer key across all marts." },
      { fieldPath: "email", nativeDataType: "varchar", description: "Login email.", pii: true },
      { fieldPath: "country", nativeDataType: "varchar", description: "ISO country code." },
      { fieldPath: "current_plan", nativeDataType: "varchar", description: "Plan slug as of the last dbt run." },
      { fieldPath: "lifetime_revenue_usd", nativeDataType: "number(14,2)", description: "Net revenue across all time." },
      { fieldPath: "first_paid_at", nativeDataType: "timestamp_ntz", description: "First successful payment." },
    ],
  },
  {
    urn: sfUrn("fct_revenue"),
    name: "fct_revenue",
    platform: "snowflake",
    description:
      "Revenue fact table: one row per successful payment, net of refunds. THE canonical source for all revenue reporting — finance dashboards and MRR both read from here.",
    domain: "Payments",
    owners: ["priya.patel", "mike.rodriguez"],
    tags: ["Tier1", "Finance"],
    terms: ["MRR", "GMV"],
    assertions: [
      {
        type: "volume",
        description: "Row count should not drop more than 20% day over day.",
        status: "pass",
        lastCheckedAt: "2026-07-31T04:10:00Z",
      },
    ],
    usage: { queryCount30d: 743, topUsers: ["priya.patel", "mike.rodriguez", "james.okafor"], trend: "up" },
    fields: [
      { fieldPath: "revenue_id", nativeDataType: "varchar", description: "Surrogate key." },
      { fieldPath: "customer_id", nativeDataType: "number", description: "FK → dim_customers.customer_id." },
      { fieldPath: "order_id", nativeDataType: "number", description: "FK → orders.id." },
      { fieldPath: "gross_amount_usd", nativeDataType: "number(12,2)", description: "Charged amount before refunds.", terms: ["GMV"] },
      { fieldPath: "net_amount_usd", nativeDataType: "number(12,2)", description: "Charged amount minus refunds — use this for revenue." },
      { fieldPath: "is_recurring", nativeDataType: "boolean", description: "True when tied to a subscription renewal.", terms: ["MRR"] },
      { fieldPath: "revenue_date", nativeDataType: "date", description: "Settlement date." },
    ],
  },
  {
    urn: sfUrn("fct_churn"),
    name: "fct_churn",
    platform: "snowflake",
    description: "Monthly churn fact: subscribers at start, churned count, and churn rate per month and plan.",
    domain: "Payments",
    owners: ["mike.rodriguez"],
    tags: ["Finance"],
    terms: ["ChurnRate"],
    usage: { queryCount30d: 189, topUsers: ["priya.patel", "mike.rodriguez"], trend: "flat" },
    fields: [
      { fieldPath: "month", nativeDataType: "date", description: "Calendar month." },
      { fieldPath: "plan", nativeDataType: "varchar", description: "Plan slug." },
      { fieldPath: "subscribers_at_start", nativeDataType: "number", description: "Active subscriptions on day 1." },
      { fieldPath: "churned", nativeDataType: "number", description: "Cancellations during the month." },
      { fieldPath: "churn_rate", nativeDataType: "number(6,4)", description: "churned / subscribers_at_start.", terms: ["ChurnRate"] },
    ],
  },
  {
    urn: sfUrn("mrr_monthly"),
    name: "mrr_monthly",
    platform: "snowflake",
    description:
      "Board-level MRR rollup by month and plan. Downstream of fct_revenue; feeds the Finance KPIs dashboard and the monthly investor update.",
    domain: "Payments",
    owners: ["priya.patel"],
    tags: ["Tier1", "Finance"],
    terms: ["MRR", "ARR"],
    assertions: [
      {
        type: "freshness",
        description: "Expected to land by 06:00 UTC daily, before the board deck refresh.",
        status: "pass",
        lastCheckedAt: "2026-07-31T06:02:00Z",
      },
    ],
    usage: { queryCount30d: 812, topUsers: ["priya.patel", "james.okafor"], trend: "flat" },
    fields: [
      { fieldPath: "month", nativeDataType: "date", description: "Calendar month." },
      { fieldPath: "plan", nativeDataType: "varchar", description: "Plan slug." },
      { fieldPath: "mrr_usd", nativeDataType: "number(14,2)", description: "Monthly recurring revenue.", terms: ["MRR"] },
      { fieldPath: "arr_usd", nativeDataType: "number(14,2)", description: "mrr_usd × 12.", terms: ["ARR"] },
      { fieldPath: "net_new_mrr_usd", nativeDataType: "number(14,2)", description: "New + expansion − contraction − churned MRR." },
    ],
  },
  {
    urn: sfUrn("events_sessionized"),
    name: "events_sessionized",
    platform: "snowflake",
    description:
      "Product events grouped into sessions (30-min inactivity window). Use this — not raw events — for activation and engagement analysis.",
    domain: "Growth",
    owners: ["james.okafor"],
    tags: [],
    terms: ["ActiveUser"],
    usage: { queryCount30d: 233, topUsers: ["james.okafor"], trend: "up" },
    fields: [
      { fieldPath: "session_id", nativeDataType: "varchar", description: "Surrogate session key." },
      { fieldPath: "user_id", nativeDataType: "number", description: "FK → users.id." },
      { fieldPath: "session_start", nativeDataType: "timestamp_ntz", description: "First event in session." },
      { fieldPath: "event_count", nativeDataType: "number", description: "Events within the session." },
      { fieldPath: "is_active_marker", nativeDataType: "boolean", description: "Counts toward the 28-day Active User definition.", terms: ["ActiveUser"] },
    ],
  },
  {
    urn: sfUrn("payment_health_daily"),
    name: "payment_health_daily",
    platform: "snowflake",
    description: "Daily payment success/failure rates by provider — the on-call dashboard for payment incidents.",
    domain: "Payments",
    owners: ["priya.patel"],
    tags: [],
    terms: [],
    assertions: [
      {
        type: "freshness",
        description: "Expected to land by 05:00 UTC daily.",
        status: "fail",
        lastCheckedAt: "2026-07-29T05:00:00Z",
      },
    ],
    usage: { queryCount30d: 96, topUsers: ["priya.patel"], trend: "flat" },
    fields: [
      { fieldPath: "date", nativeDataType: "date", description: "Calendar day." },
      { fieldPath: "provider", nativeDataType: "varchar", description: "stripe | paypal." },
      { fieldPath: "attempts", nativeDataType: "number", description: "Payment attempts." },
      { fieldPath: "success_rate", nativeDataType: "number(6,4)", description: "succeeded / attempts." },
    ],
  },
];

/** downstream urn → upstream urns */
export const DEMO_LINEAGE: Record<string, string[]> = {
  [sfUrn("stg_users")]: [pgUrn("users")],
  [sfUrn("stg_payments")]: [pgUrn("payments")],
  [sfUrn("dim_customers")]: [sfUrn("stg_users"), sfUrn("stg_payments")],
  [sfUrn("fct_revenue")]: [sfUrn("stg_payments"), pgUrn("orders"), pgUrn("refunds")],
  [sfUrn("fct_churn")]: [pgUrn("subscriptions"), sfUrn("dim_customers")],
  [sfUrn("mrr_monthly")]: [sfUrn("fct_revenue")],
  [sfUrn("events_sessionized")]: [pgUrn("events")],
  [sfUrn("payment_health_daily")]: [sfUrn("stg_payments")],
};

export const DEMO_QUERIES: DemoQuery[] = [
  {
    id: "monthly-mrr-trend",
    name: "Monthly MRR trend by plan",
    description: "How finance pulls the MRR trend for the board deck.",
    sql: "SELECT month, plan, mrr_usd, net_new_mrr_usd\nFROM analytics.marts.mrr_monthly\nWHERE month >= DATEADD(month, -12, CURRENT_DATE)\nORDER BY month, plan;",
    subjects: [sfUrn("mrr_monthly")],
  },
  {
    id: "revenue-by-country",
    name: "Net revenue by customer country (last 90 days)",
    description: "Standard revenue-by-geo cut used in weekly business review.",
    sql: "SELECT c.country, SUM(r.net_amount_usd) AS net_revenue\nFROM analytics.marts.fct_revenue r\nJOIN analytics.marts.dim_customers c ON c.customer_id = r.customer_id\nWHERE r.revenue_date >= DATEADD(day, -90, CURRENT_DATE)\nGROUP BY 1 ORDER BY 2 DESC;",
    subjects: [sfUrn("fct_revenue"), sfUrn("dim_customers")],
  },
  {
    id: "churn-analysis",
    name: "Churn rate by plan with 3-month average",
    description: "The canonical churn analysis query — start here for any churn question.",
    sql: "SELECT month, plan, churn_rate,\n       AVG(churn_rate) OVER (PARTITION BY plan ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS churn_rate_3mo\nFROM analytics.marts.fct_churn\nORDER BY month DESC, plan;",
    subjects: [sfUrn("fct_churn")],
  },
  {
    id: "active-users-28d",
    name: "28-day active users",
    description: "Implements the glossary 'Active User' definition.",
    sql: "SELECT COUNT(DISTINCT user_id) AS active_users_28d\nFROM analytics.marts.events_sessionized\nWHERE session_start >= DATEADD(day, -28, CURRENT_DATE)\n  AND is_active_marker;",
    subjects: [sfUrn("events_sessionized")],
  },
  {
    id: "payment-success-daily",
    name: "Payment success rate by provider",
    description: "On-call query when payment alarms fire.",
    sql: "SELECT date, provider, success_rate\nFROM analytics.marts.payment_health_daily\nWHERE date >= DATEADD(day, -14, CURRENT_DATE)\nORDER BY date DESC, provider;",
    subjects: [sfUrn("payment_health_daily")],
  },
];
