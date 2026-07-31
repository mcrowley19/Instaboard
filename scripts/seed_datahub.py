# /// script
# requires-python = ">=3.10"
# dependencies = ["acryl-datahub>=0.14.0"]
# ///
"""
Seed a local DataHub instance with a realistic demo catalog for "Northbeam",
a fictional subscription-commerce company.

Creates: users/tags/glossary terms/domains, 14 datasets across postgres +
snowflake with schemas, owners, tags, docs, column-level PII flags, lineage
across 4 pipelines, and saved SQL queries on the key tables.

Usage:
    DATAHUB_GMS_URL=http://localhost:8080 npm run seed
"""

import os
import time

from datahub.emitter.mce_builder import (
    make_data_platform_urn,
    make_dataset_urn,
    make_domain_urn,
    make_term_urn,
    make_tag_urn,
    make_user_urn,
)
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.emitter.rest_emitter import DatahubRestEmitter
from datahub.emitter.mce_builder import make_assertion_urn
from datahub.metadata.schema_classes import (
    AssertionInfoClass,
    AssertionResultClass,
    AssertionResultTypeClass,
    AssertionRunEventClass,
    AssertionRunStatusClass,
    AssertionStdAggregationClass,
    AssertionStdOperatorClass,
    AssertionStdParameterClass,
    AssertionStdParametersClass,
    AssertionStdParameterTypeClass,
    AssertionTypeClass,
    AuditStampClass,
    CalendarIntervalClass,
    CorpUserInfoClass,
    DatasetAssertionInfoClass,
    DatasetAssertionScopeClass,
    DatasetLineageTypeClass,
    DatasetPropertiesClass,
    DatasetUsageStatisticsClass,
    DatasetUserUsageCountsClass,
    DeprecationClass,
    DomainPropertiesClass,
    DomainsClass,
    GlobalTagsClass,
    GlossaryTermAssociationClass,
    GlossaryTermInfoClass,
    GlossaryTermsClass,
    IncidentInfoClass,
    IncidentSourceClass,
    IncidentSourceTypeClass,
    IncidentStateClass,
    IncidentStatusClass,
    IncidentTypeClass,
    NumberTypeClass,
    OtherSchemaClass,
    OwnerClass,
    OwnershipClass,
    OwnershipTypeClass,
    QueryLanguageClass,
    QueryPropertiesClass,
    QuerySourceClass,
    QueryStatementClass,
    QuerySubjectClass,
    QuerySubjectsClass,
    SchemaFieldClass,
    SchemaFieldDataTypeClass,
    SchemaMetadataClass,
    StringTypeClass,
    TagAssociationClass,
    TagPropertiesClass,
    TimeTypeClass,
    TimeWindowSizeClass,
    UpstreamClass,
    UpstreamLineageClass,
)

GMS = os.environ.get("DATAHUB_GMS_URL", "http://localhost:8080")
TOKEN = os.environ.get("DATAHUB_GMS_TOKEN") or None

emitter = DatahubRestEmitter(gms_server=GMS, token=TOKEN)

NOW = AuditStampClass(time=int(time.time() * 1000), actor="urn:li:corpuser:datahub")


def emit(entity_urn, aspect):
    emitter.emit(MetadataChangeProposalWrapper(entityUrn=entity_urn, aspect=aspect))


# ── people ────────────────────────────────────────────────────────────────
USERS = {
    "sarah.chen": ("Sarah Chen", "Staff Data Engineer", "sarah.chen@northbeam.io"),
    "mike.rodriguez": ("Mike Rodriguez", "Analytics Engineer", "mike.rodriguez@northbeam.io"),
    "priya.patel": ("Priya Patel", "Payments Data Lead", "priya.patel@northbeam.io"),
    "james.okafor": ("James Okafor", "Senior Growth Analyst", "james.okafor@northbeam.io"),
}

# ── tags ──────────────────────────────────────────────────────────────────
TAGS = {
    "PII": "Contains personally identifiable information. Access is audited; never export to third parties.",
    "Tier1": "Business-critical dataset. Breakage pages the on-call data engineer.",
    "Deprecated": "Scheduled for removal. Do not build new dependencies on this.",
    "Finance": "Used in financial reporting. Changes require sign-off from the Payments data lead.",
}

# ── glossary ──────────────────────────────────────────────────────────────
TERMS = {
    "MRR": (
        "Monthly Recurring Revenue",
        "Sum of all active subscription amounts normalized to a monthly value. "
        "Computed in analytics.mrr_monthly from fct_revenue, excluding one-time fees and refunds. "
        "Annual plans are divided by 12.",
    ),
    "ARR": ("Annual Recurring Revenue", "MRR × 12. Reported to the board monthly; sourced from analytics.mrr_monthly."),
    "ChurnRate": (
        "Churn Rate",
        "Percentage of subscribers who cancel in a period: churned_subscribers / subscribers_at_period_start. "
        "Computed in analytics.fct_churn; the canonical definition uses calendar months.",
    ),
    "GMV": ("Gross Merchandise Value", "Total value of orders before refunds, fees, and discounts. Sourced from app orders."),
    "ActiveUser": ("Active User", "A user with at least one product event in the trailing 28 days (see analytics.events_sessionized)."),
}

# ── domains ───────────────────────────────────────────────────────────────
DOMAINS = {
    "Payments": "Billing, payment processing, revenue and finance reporting.",
    "Growth": "Product analytics, activation, retention and experimentation.",
    "Core": "Source-of-truth application data owned by data engineering.",
}


def pg(table: str) -> str:
    return make_dataset_urn(platform="postgres", name=f"northbeam_app.public.{table}", env="PROD")


def sf(table: str) -> str:
    return make_dataset_urn(platform="snowflake", name=f"analytics.marts.{table}", env="PROD")


STRING = SchemaFieldDataTypeClass(type=StringTypeClass())
NUMBER = SchemaFieldDataTypeClass(type=NumberTypeClass())
TIME = SchemaFieldDataTypeClass(type=TimeTypeClass())


def field(path, dtype, native, desc, pii=False, terms=None):
    return SchemaFieldClass(
        fieldPath=path,
        type=dtype,
        nativeDataType=native,
        description=desc,
        globalTags=GlobalTagsClass(tags=[TagAssociationClass(tag=make_tag_urn("PII"))]) if pii else None,
        glossaryTerms=(
            GlossaryTermsClass(
                terms=[GlossaryTermAssociationClass(urn=make_term_urn(t)) for t in terms],
                auditStamp=NOW,
            )
            if terms
            else None
        ),
    )


# ── datasets ──────────────────────────────────────────────────────────────
# (urn, name-for-schema, description, domain, owners, tags, terms, fields)
DATASETS = [
    (
        pg("users"),
        "users",
        "Source-of-truth user accounts from the production app. One row per registered user. "
        "Synced to Snowflake hourly via Fivetran.",
        "Core",
        ["sarah.chen"],
        ["Tier1"],
        [],
        [
            field("id", NUMBER, "bigint", "Primary key. Referenced everywhere as user_id / customer_id."),
            field("email", STRING, "varchar", "Login email. Unique. Used for billing receipts and lifecycle emails.", pii=True),
            field("full_name", STRING, "varchar", "Display name entered at signup.", pii=True),
            field("country", STRING, "varchar", "ISO-3166 country code, from billing address."),
            field("plan", STRING, "varchar", "Current plan slug: free | starter | pro | enterprise."),
            field("created_at", TIME, "timestamp", "Signup timestamp (UTC)."),
        ],
    ),
    (
        pg("orders"),
        "orders",
        "One row per checkout. Includes one-time purchases and the initial order of a subscription.",
        "Core",
        ["sarah.chen"],
        ["Tier1"],
        ["GMV"],
        [
            field("id", NUMBER, "bigint", "Primary key."),
            field("user_id", NUMBER, "bigint", "FK → users.id."),
            field("total_amount", NUMBER, "numeric(12,2)", "Order total in USD, pre-refund.", terms=["GMV"]),
            field("status", STRING, "varchar", "pending | paid | cancelled | refunded."),
            field("created_at", TIME, "timestamp", "Checkout timestamp (UTC)."),
        ],
    ),
    (
        pg("payments"),
        "payments",
        "Raw payment attempts from the Stripe webhook consumer. Includes failures and retries — "
        "filter to status='succeeded' for revenue work.",
        "Payments",
        ["priya.patel", "sarah.chen"],
        ["Tier1", "Finance"],
        [],
        [
            field("id", NUMBER, "bigint", "Primary key."),
            field("order_id", NUMBER, "bigint", "FK → orders.id."),
            field("user_id", NUMBER, "bigint", "FK → users.id."),
            field("amount", NUMBER, "numeric(12,2)", "Charged amount in USD."),
            field("status", STRING, "varchar", "succeeded | failed | pending | disputed."),
            field("provider", STRING, "varchar", "stripe | paypal."),
            field("card_last4", STRING, "varchar", "Last 4 digits of the card.", pii=True),
            field("created_at", TIME, "timestamp", "Attempt timestamp (UTC)."),
        ],
    ),
    (
        pg("subscriptions"),
        "subscriptions",
        "Subscription lifecycle table. One row per subscription; status transitions drive churn metrics.",
        "Payments",
        ["priya.patel"],
        ["Tier1", "Finance"],
        ["MRR", "ChurnRate"],
        [
            field("id", NUMBER, "bigint", "Primary key."),
            field("user_id", NUMBER, "bigint", "FK → users.id."),
            field("plan", STRING, "varchar", "Plan slug at the current term."),
            field("monthly_amount", NUMBER, "numeric(12,2)", "Normalized monthly price in USD.", terms=["MRR"]),
            field("status", STRING, "varchar", "trialing | active | past_due | cancelled."),
            field("started_at", TIME, "timestamp", "Subscription start."),
            field("cancelled_at", TIME, "timestamp", "Cancellation timestamp, null while active.", terms=["ChurnRate"]),
        ],
    ),
    (
        pg("events"),
        "events",
        "Product event firehose from the web and mobile clients (Segment). ~40M rows/day; "
        "query the sessionized mart instead of this raw table where possible.",
        "Growth",
        ["james.okafor", "sarah.chen"],
        [],
        ["ActiveUser"],
        [
            field("event_id", STRING, "uuid", "Unique event id."),
            field("user_id", NUMBER, "bigint", "FK → users.id; null for anonymous traffic."),
            field("event_name", STRING, "varchar", "e.g. page_view, checkout_started, feature_used."),
            field("properties", STRING, "jsonb", "Free-form event payload."),
            field("occurred_at", TIME, "timestamp", "Client-side event timestamp (UTC)."),
        ],
    ),
    (
        pg("refunds"),
        "refunds",
        "Refunds issued against payments. Joined into fct_revenue to compute net revenue.",
        "Payments",
        ["priya.patel"],
        ["Finance"],
        [],
        [
            field("id", NUMBER, "bigint", "Primary key."),
            field("payment_id", NUMBER, "bigint", "FK → payments.id."),
            field("amount", NUMBER, "numeric(12,2)", "Refunded amount in USD."),
            field("reason", STRING, "varchar", "requested_by_customer | fraud | duplicate."),
            field("created_at", TIME, "timestamp", "Refund timestamp (UTC)."),
        ],
    ),
    (
        sf("stg_users"),
        "stg_users",
        "Staging model over app users: renames, type casts, and email-domain extraction. "
        "Materialized hourly by dbt (northbeam_dbt.staging).",
        "Core",
        ["mike.rodriguez"],
        [],
        [],
        [
            field("user_id", NUMBER, "number", "users.id passthrough."),
            field("email", STRING, "varchar", "Lowercased login email.", pii=True),
            field("email_domain", STRING, "varchar", "Domain part of email — used for B2B account grouping."),
            field("country", STRING, "varchar", "ISO country code."),
            field("plan", STRING, "varchar", "Current plan slug."),
            field("signed_up_at", TIME, "timestamp_ntz", "Signup timestamp."),
        ],
    ),
    (
        sf("stg_payments"),
        "stg_payments",
        "Staging model over raw payments: filters to terminal states and deduplicates retries.",
        "Payments",
        ["mike.rodriguez", "priya.patel"],
        ["Finance"],
        [],
        [
            field("payment_id", NUMBER, "number", "payments.id passthrough."),
            field("order_id", NUMBER, "number", "FK → orders.id."),
            field("user_id", NUMBER, "number", "FK → users.id."),
            field("amount_usd", NUMBER, "number(12,2)", "Charged amount in USD."),
            field("is_successful", STRING, "boolean", "True when status = succeeded."),
            field("paid_at", TIME, "timestamp_ntz", "Settlement timestamp."),
        ],
    ),
    (
        sf("dim_customers"),
        "dim_customers",
        "Customer dimension: one row per user with lifetime aggregates. The join key for almost every mart.",
        "Core",
        ["mike.rodriguez"],
        ["Tier1"],
        [],
        [
            field("customer_id", NUMBER, "number", "= users.id. Canonical customer key across all marts.", terms=[]),
            field("email", STRING, "varchar", "Login email.", pii=True),
            field("country", STRING, "varchar", "ISO country code."),
            field("current_plan", STRING, "varchar", "Plan slug as of the last dbt run."),
            field("lifetime_revenue_usd", NUMBER, "number(14,2)", "Net revenue across all time."),
            field("first_paid_at", TIME, "timestamp_ntz", "First successful payment."),
        ],
    ),
    (
        sf("fct_revenue"),
        "fct_revenue",
        "Revenue fact table: one row per successful payment, net of refunds. THE canonical source for "
        "all revenue reporting — finance dashboards and MRR both read from here.",
        "Payments",
        ["priya.patel", "mike.rodriguez"],
        ["Tier1", "Finance"],
        ["MRR", "GMV"],
        [
            field("revenue_id", STRING, "varchar", "Surrogate key."),
            field("customer_id", NUMBER, "number", "FK → dim_customers.customer_id."),
            field("order_id", NUMBER, "number", "FK → orders.id."),
            field("gross_amount_usd", NUMBER, "number(12,2)", "Charged amount before refunds.", terms=["GMV"]),
            field("net_amount_usd", NUMBER, "number(12,2)", "Charged amount minus refunds — use this for revenue."),
            field("is_recurring", STRING, "boolean", "True when tied to a subscription renewal.", terms=["MRR"]),
            field("revenue_date", TIME, "date", "Settlement date."),
        ],
    ),
    (
        sf("fct_churn"),
        "fct_churn",
        "Monthly churn fact: subscribers at start, churned count, and churn rate per month and plan.",
        "Payments",
        ["mike.rodriguez"],
        ["Finance"],
        ["ChurnRate"],
        [
            field("month", TIME, "date", "Calendar month."),
            field("plan", STRING, "varchar", "Plan slug."),
            field("subscribers_at_start", NUMBER, "number", "Active subscriptions on day 1."),
            field("churned", NUMBER, "number", "Cancellations during the month."),
            field("churn_rate", NUMBER, "number(6,4)", "churned / subscribers_at_start.", terms=["ChurnRate"]),
        ],
    ),
    (
        sf("mrr_monthly"),
        "mrr_monthly",
        "Board-level MRR rollup by month and plan. Downstream of fct_revenue; feeds the Finance KPIs "
        "dashboard and the monthly investor update.",
        "Payments",
        ["priya.patel"],
        ["Tier1", "Finance"],
        ["MRR", "ARR"],
        [
            field("month", TIME, "date", "Calendar month."),
            field("plan", STRING, "varchar", "Plan slug."),
            field("mrr_usd", NUMBER, "number(14,2)", "Monthly recurring revenue.", terms=["MRR"]),
            field("arr_usd", NUMBER, "number(14,2)", "mrr_usd × 12.", terms=["ARR"]),
            field("net_new_mrr_usd", NUMBER, "number(14,2)", "New + expansion − contraction − churned MRR."),
        ],
    ),
    (
        sf("events_sessionized"),
        "events_sessionized",
        "Product events grouped into sessions (30-min inactivity window). Use this — not raw events — "
        "for activation and engagement analysis.",
        "Growth",
        ["james.okafor"],
        [],
        ["ActiveUser"],
        [
            field("session_id", STRING, "varchar", "Surrogate session key."),
            field("user_id", NUMBER, "number", "FK → users.id."),
            field("session_start", TIME, "timestamp_ntz", "First event in session."),
            field("event_count", NUMBER, "number", "Events within the session."),
            field("is_active_marker", STRING, "boolean", "Counts toward the 28-day Active User definition.", terms=["ActiveUser"]),
        ],
    ),
    (
        sf("payment_health_daily"),
        "payment_health_daily",
        "Daily payment success/failure rates by provider — the on-call dashboard for payment incidents.",
        "Payments",
        ["priya.patel"],
        [],
        [],
        [
            field("date", TIME, "date", "Calendar day."),
            field("provider", STRING, "varchar", "stripe | paypal."),
            field("attempts", NUMBER, "number", "Payment attempts."),
            field("success_rate", NUMBER, "number(6,4)", "succeeded / attempts."),
        ],
    ),
]

# ── lineage (downstream ← upstreams) ─────────────────────────────────────
LINEAGE = {
    sf("stg_users"): [pg("users")],
    sf("stg_payments"): [pg("payments")],
    sf("dim_customers"): [sf("stg_users"), sf("stg_payments")],
    sf("fct_revenue"): [sf("stg_payments"), pg("orders"), pg("refunds")],
    sf("fct_churn"): [pg("subscriptions"), sf("dim_customers")],
    sf("mrr_monthly"): [sf("fct_revenue")],
    sf("events_sessionized"): [pg("events")],
    sf("payment_health_daily"): [sf("stg_payments")],
}

# ── saved queries ────────────────────────────────────────────────────────
QUERIES = [
    (
        "monthly-mrr-trend",
        "Monthly MRR trend by plan",
        "How finance pulls the MRR trend for the board deck.",
        "SELECT month, plan, mrr_usd, net_new_mrr_usd\nFROM analytics.marts.mrr_monthly\nWHERE month >= DATEADD(month, -12, CURRENT_DATE)\nORDER BY month, plan;",
        [sf("mrr_monthly")],
    ),
    (
        "revenue-by-country",
        "Net revenue by customer country (last 90 days)",
        "Standard revenue-by-geo cut used in weekly business review.",
        "SELECT c.country, SUM(r.net_amount_usd) AS net_revenue\nFROM analytics.marts.fct_revenue r\nJOIN analytics.marts.dim_customers c ON c.customer_id = r.customer_id\nWHERE r.revenue_date >= DATEADD(day, -90, CURRENT_DATE)\nGROUP BY 1 ORDER BY 2 DESC;",
        [sf("fct_revenue"), sf("dim_customers")],
    ),
    (
        "churn-analysis",
        "Churn rate by plan with 3-month average",
        "The canonical churn analysis query — start here for any churn question.",
        "SELECT month, plan, churn_rate,\n       AVG(churn_rate) OVER (PARTITION BY plan ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS churn_rate_3mo\nFROM analytics.marts.fct_churn\nORDER BY month DESC, plan;",
        [sf("fct_churn")],
    ),
    (
        "active-users-28d",
        "28-day active users",
        "Implements the glossary 'Active User' definition.",
        "SELECT COUNT(DISTINCT user_id) AS active_users_28d\nFROM analytics.marts.events_sessionized\nWHERE session_start >= DATEADD(day, -28, CURRENT_DATE)\n  AND is_active_marker;",
        [sf("events_sessionized")],
    ),
    (
        "payment-success-daily",
        "Payment success rate by provider",
        "On-call query when payment alarms fire.",
        "SELECT date, provider, success_rate\nFROM analytics.marts.payment_health_daily\nWHERE date >= DATEADD(day, -14, CURRENT_DATE)\nORDER BY date DESC, provider;",
        [sf("payment_health_daily")],
    ),
]


# ── deprecation ───────────────────────────────────────────────────────────
# urn -> (note, replacement urn)
DEPRECATIONS = {
    pg("events"): (
        "Superseded by events_sessionized for all activation/engagement analysis — "
        "this raw firehose is kept only for pipeline debugging.",
        sf("events_sessionized"),
    ),
}

# ── open incidents ───────────────────────────────────────────────────────
# (id, dataset urn, title)
INCIDENTS = [
    (
        "payments-webhook-duplicates",
        pg("payments"),
        "Stripe webhook retry storms are producing duplicate payment rows during provider outages",
    ),
]

# ── data quality assertions ─────────────────────────────────────────────
# (id, dataset urn, description, scope kwargs, result type)
ASSERTIONS = [
    (
        "fct-revenue-row-count",
        sf("fct_revenue"),
        "Row count should not drop more than 20% day over day.",
        dict(
            scope=DatasetAssertionScopeClass.DATASET_ROWS,
            operator=AssertionStdOperatorClass.GREATER_THAN,
            aggregation=AssertionStdAggregationClass.ROW_COUNT,
            parameters=AssertionStdParametersClass(
                value=AssertionStdParameterClass(value="0", type=AssertionStdParameterTypeClass.NUMBER)
            ),
        ),
        AssertionResultTypeClass.SUCCESS,
    ),
    (
        "payment-health-freshness",
        sf("payment_health_daily"),
        "Latest date column should be within 1 day of today.",
        dict(
            scope=DatasetAssertionScopeClass.DATASET_COLUMN,
            fields=["date"],
            operator=AssertionStdOperatorClass.GREATER_THAN_OR_EQUAL_TO,
            aggregation=AssertionStdAggregationClass.MAX,
            parameters=AssertionStdParametersClass(
                value=AssertionStdParameterClass(value="yesterday", type=AssertionStdParameterTypeClass.STRING)
            ),
        ),
        AssertionResultTypeClass.FAILURE,
    ),
]

# ── usage stats (last 30 days) ───────────────────────────────────────────
# urn -> (totalSqlQueries, [top user usernames])
USAGE_STATS = {
    pg("users"): (412, ["mike.rodriguez", "james.okafor"]),
    pg("orders"): (268, ["mike.rodriguez"]),
    pg("payments"): (356, ["priya.patel", "mike.rodriguez"]),
    pg("subscriptions"): (301, ["priya.patel", "mike.rodriguez"]),
    pg("events"): (74, ["james.okafor"]),
    pg("refunds"): (58, ["priya.patel"]),
    sf("stg_users"): (22, ["mike.rodriguez"]),
    sf("stg_payments"): (19, ["mike.rodriguez"]),
    sf("dim_customers"): (587, ["mike.rodriguez", "priya.patel", "james.okafor"]),
    sf("fct_revenue"): (743, ["priya.patel", "mike.rodriguez", "james.okafor"]),
    sf("fct_churn"): (189, ["priya.patel", "mike.rodriguez"]),
    sf("mrr_monthly"): (812, ["priya.patel", "james.okafor"]),
    sf("events_sessionized"): (233, ["james.okafor"]),
    sf("payment_health_daily"): (96, ["priya.patel"]),
}


def main() -> None:
    print(f"Seeding DataHub at {GMS} …")

    # people
    for username, (name, title, email) in USERS.items():
        emit(
            make_user_urn(username),
            CorpUserInfoClass(active=True, displayName=name, title=title, email=email, fullName=name),
        )
    print(f"  ✓ {len(USERS)} users")

    # tags
    for tag, desc in TAGS.items():
        emit(make_tag_urn(tag), TagPropertiesClass(name=tag, description=desc))
    print(f"  ✓ {len(TAGS)} tags")

    # glossary terms
    for term, (name, definition) in TERMS.items():
        emit(
            make_term_urn(term),
            GlossaryTermInfoClass(name=name, definition=definition, termSource="INTERNAL"),
        )
    print(f"  ✓ {len(TERMS)} glossary terms")

    # domains
    for domain, desc in DOMAINS.items():
        emit(make_domain_urn(domain), DomainPropertiesClass(name=domain, description=desc))
    print(f"  ✓ {len(DOMAINS)} domains")

    # datasets
    for urn, name, desc, domain, owners, tags, terms, fields in DATASETS:
        platform = "postgres" if "postgres" in urn else "snowflake"
        emit(urn, DatasetPropertiesClass(name=name, description=desc))
        emit(
            urn,
            SchemaMetadataClass(
                schemaName=name,
                platform=make_data_platform_urn(platform),
                version=0,
                hash="",
                platformSchema=OtherSchemaClass(rawSchema=""),
                fields=fields,
            ),
        )
        emit(
            urn,
            OwnershipClass(
                owners=[
                    OwnerClass(owner=make_user_urn(o), type=OwnershipTypeClass.TECHNICAL_OWNER)
                    for o in owners
                ]
            ),
        )
        emit(urn, DomainsClass(domains=[make_domain_urn(domain)]))
        if tags:
            emit(urn, GlobalTagsClass(tags=[TagAssociationClass(tag=make_tag_urn(t)) for t in tags]))
        if terms:
            emit(
                urn,
                GlossaryTermsClass(
                    terms=[GlossaryTermAssociationClass(urn=make_term_urn(t)) for t in terms],
                    auditStamp=NOW,
                ),
            )
    print(f"  ✓ {len(DATASETS)} datasets (schemas, owners, domains, tags, terms)")

    # lineage
    for downstream, upstreams in LINEAGE.items():
        emit(
            downstream,
            UpstreamLineageClass(
                upstreams=[
                    UpstreamClass(dataset=u, type=DatasetLineageTypeClass.TRANSFORMED)
                    for u in upstreams
                ]
            ),
        )
    print(f"  ✓ lineage for {len(LINEAGE)} datasets")

    # saved queries
    for query_id, title, desc, sql, subjects in QUERIES:
        query_urn = f"urn:li:query:northbeam-{query_id}"
        emit(
            query_urn,
            QueryPropertiesClass(
                statement=QueryStatementClass(value=sql, language=QueryLanguageClass.SQL),
                source=QuerySourceClass.MANUAL,
                name=title,
                description=desc,
                created=NOW,
                lastModified=NOW,
            ),
        )
        emit(
            query_urn,
            QuerySubjectsClass(subjects=[QuerySubjectClass(entity=s) for s in subjects]),
        )
    print(f"  ✓ {len(QUERIES)} saved queries")

    # deprecation
    for urn, (note, replacement) in DEPRECATIONS.items():
        emit(
            urn,
            DeprecationClass(
                deprecated=True,
                note=note,
                actor=make_user_urn("sarah.chen"),
                replacement=replacement,
            ),
        )
    print(f"  ✓ {len(DEPRECATIONS)} deprecation notice(s)")

    # open incidents
    for incident_id, urn, title in INCIDENTS:
        emit(
            f"urn:li:incident:{incident_id}",
            IncidentInfoClass(
                type=IncidentTypeClass.OPERATIONAL,
                entities=[urn],
                status=IncidentStatusClass(state=IncidentStateClass.ACTIVE, lastUpdated=NOW),
                created=NOW,
                title=title,
                source=IncidentSourceClass(type=IncidentSourceTypeClass.MANUAL),
            ),
        )
    print(f"  ✓ {len(INCIDENTS)} open incident(s)")

    # data quality assertions + their latest run result
    for assertion_id, urn, description, dataset_assertion_kwargs, result_type in ASSERTIONS:
        assertion_urn = make_assertion_urn(assertion_id)
        emit(
            assertion_urn,
            AssertionInfoClass(
                type=AssertionTypeClass.DATASET,
                datasetAssertion=DatasetAssertionInfoClass(dataset=urn, **dataset_assertion_kwargs),
                description=description,
            ),
        )
        emit(
            assertion_urn,
            AssertionRunEventClass(
                timestampMillis=NOW.time,
                runId=f"{assertion_id}-{NOW.time}",
                asserteeUrn=urn,
                status=AssertionRunStatusClass.COMPLETE,
                assertionUrn=assertion_urn,
                result=AssertionResultClass(type=result_type),
            ),
        )
    print(f"  ✓ {len(ASSERTIONS)} assertions (with latest run result)")

    # usage stats (last 30 days)
    for urn, (total_queries, top_users) in USAGE_STATS.items():
        per_user = max(total_queries // len(top_users), 1)
        emit(
            urn,
            DatasetUsageStatisticsClass(
                timestampMillis=NOW.time,
                eventGranularity=TimeWindowSizeClass(unit=CalendarIntervalClass.DAY, multiple=30),
                uniqueUserCount=len(top_users),
                totalSqlQueries=total_queries,
                userCounts=[
                    DatasetUserUsageCountsClass(user=make_user_urn(u), count=per_user) for u in top_users
                ],
            ),
        )
    print(f"  ✓ usage stats for {len(USAGE_STATS)} datasets")

    print("\nDone. Open http://localhost:9002 and search for 'revenue' to verify.")


if __name__ == "__main__":
    main()
