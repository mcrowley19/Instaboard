/**
 * The instaboard onboarding benchmark.
 *
 * 20 questions a real new hire asks in week 1, each with deterministic,
 * catalog-grounded pass/fail checks. No LLM judge — every check is a string or
 * regex match against facts that live in the Northbeam catalog
 * (`lib/demo-catalog.ts`, and the same catalog `npm run seed` ingests into a
 * live DataHub). That makes the score reproducible by anyone, including judges,
 * and impossible to game with confident-sounding prose.
 *
 * The same cases run twice: once with DataHub MCP tools (`grounded`) and once
 * with the tool list emptied (`blind`). The gap between the two arms is the
 * measurement that matters — it is the value DataHub adds, isolated.
 */

export type Category =
  | "grounding"
  | "ownership"
  | "lineage"
  | "health-trap"
  | "usage"
  | "glossary"
  | "sql"
  | "hallucination";

export interface EvalCase<C extends string = Category> {
  id: string;
  category: C;
  question: string;
  /** Why a new hire getting this wrong actually costs the team something. */
  stakes: string;
  /**
   * Each entry is an OR-group: the answer must contain at least one of the
   * alternatives. All groups must be satisfied.
   */
  mustInclude: { label: string; anyOf: string[] }[];
  /** Substrings that must NOT appear — wrong tables, invented entities, unsafe advice. */
  mustNotInclude?: { label: string; anyOf: string[] }[];
}

/** Fully-qualified URNs, matching lib/demo-catalog.ts exactly. */
const PG = (t: string) => `urn:li:dataset:(urn:li:dataPlatform:postgres,northbeam.public.${t},PROD)`;
const SF = (t: string) => `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.${t},PROD)`;

export const BENCHMARK: EvalCase[] = [
  /* ── Grounding: does it name the real entities, with real URNs? ──────── */
  {
    id: "revenue-tables",
    category: "grounding",
    question: "What tables do we use for revenue?",
    stakes: "A new hire who queries the wrong revenue table reports numbers finance will contradict.",
    mustInclude: [
      { label: "names fct_revenue", anyOf: ["fct_revenue"] },
      { label: "names the MRR rollup", anyOf: ["mrr_monthly"] },
      { label: "cites a real URN", anyOf: [SF("fct_revenue"), SF("mrr_monthly")] },
    ],
    mustNotInclude: [
      { label: "invents a revenue table", anyOf: ["revenue_daily", "fact_revenue", "revenue_summary", "dim_revenue"] },
    ],
  },
  {
    id: "mrr-computed-where",
    category: "grounding",
    question: "Where is MRR actually computed? I need the table the board deck reads from.",
    stakes: "Recomputing MRR by hand from payments is the classic new-hire mistake that produces a second, wrong number.",
    mustInclude: [
      { label: "names mrr_monthly", anyOf: ["mrr_monthly"] },
      { label: "names its upstream fact", anyOf: ["fct_revenue"] },
      { label: "cites the URN", anyOf: [SF("mrr_monthly")] },
    ],
  },
  {
    id: "customer-id-definition",
    category: "grounding",
    question: "How is customer_id defined, and which table is the source of truth for customers?",
    stakes: "Joining on the wrong customer key silently drops or fans out rows.",
    mustInclude: [
      { label: "names dim_customers", anyOf: ["dim_customers"] },
      { label: "cites the URN", anyOf: [SF("dim_customers")] },
    ],
  },

  /* ── Ownership: real people, not plausible ones ──────────────────────── */
  {
    id: "payments-owner",
    category: "ownership",
    question: "Who owns the payments pipeline? I need to ask about a discrepancy.",
    stakes: "Messaging the wrong person costs a day; inventing a person costs credibility.",
    mustInclude: [{ label: "names Priya Patel", anyOf: ["Priya Patel", "priya.patel"] }],
    mustNotInclude: [
      { label: "invents an owner", anyOf: ["John Smith", "Jane Doe", "data-eng@", "the data team owns"] },
    ],
  },
  {
    id: "growth-owner",
    category: "ownership",
    question: "Who should I ask about the product events data?",
    stakes: "Growth data has a specific owner; a generic answer sends the new hire to a dead end.",
    mustInclude: [{ label: "names James Okafor", anyOf: ["James Okafor", "james.okafor"] }],
  },

  /* ── Lineage: the graph DataHub actually holds ───────────────────────── */
  {
    id: "email-blast-radius",
    category: "lineage",
    question: "What breaks if I change the email column on the users table?",
    stakes: "Shipping a column change without the downstream list is how a mart silently breaks overnight.",
    mustInclude: [
      { label: "names the staging model", anyOf: ["stg_users"] },
      { label: "names the downstream dim", anyOf: ["dim_customers"] },
    ],
  },
  {
    id: "fct-revenue-upstream",
    category: "lineage",
    question: "Where does fct_revenue get its data from?",
    stakes: "Debugging a revenue discrepancy starts with knowing the three real inputs, not guessing.",
    mustInclude: [
      { label: "names stg_payments", anyOf: ["stg_payments"] },
      { label: "names orders", anyOf: ["orders"] },
      { label: "names refunds", anyOf: ["refunds"] },
    ],
  },
  {
    id: "mrr-debug-upstream",
    category: "lineage",
    question: "The MRR number looks wrong this month. What should I check upstream?",
    stakes: "Without lineage the new hire debugs the rollup instead of the fact table that feeds it.",
    mustInclude: [{ label: "points at fct_revenue", anyOf: ["fct_revenue"] }],
  },

  /* ── Health traps: the answers that are confidently wrong without DataHub ── */
  {
    id: "deprecated-events-trap",
    category: "health-trap",
    question: "Is it safe to build a new engagement report on the raw events table?",
    stakes: "events is deprecated. Building on it means rebuilding the report in a month.",
    mustInclude: [
      { label: "flags it as deprecated", anyOf: ["deprecated", "deprecation", "superseded"] },
      { label: "points to the replacement", anyOf: ["events_sessionized"] },
    ],
    mustNotInclude: [
      { label: "recommends it without warning", anyOf: ["yes, it's safe", "yes — it's safe", "safe to build on the raw events"] },
    ],
  },
  {
    id: "active-users-table",
    category: "health-trap",
    question: "I need to count 28-day active users. Which table should I query?",
    stakes: "The obvious answer (raw events) is the deprecated one; only the catalog knows that.",
    mustInclude: [
      { label: "routes to events_sessionized", anyOf: ["events_sessionized"] },
      { label: "references the active-user marker or definition", anyOf: ["is_active_marker", "Active User", "28-day"] },
    ],
  },
  {
    id: "payments-open-incident",
    category: "health-trap",
    question: "Any reason to be careful using the payments table right now?",
    stakes: "There is an open incident producing duplicate rows. Not knowing means double-counted revenue.",
    mustInclude: [
      { label: "surfaces the open incident", anyOf: ["incident", "duplicate", "retry storm", "retry storms"] },
    ],
  },
  {
    id: "payment-health-freshness",
    category: "health-trap",
    question: "Is payment_health_daily reliable right now? I want to use it for an on-call check.",
    stakes: "Its freshness assertion is failing — the data is stale and the on-call check would be misleading.",
    mustInclude: [
      { label: "flags the failing assertion or staleness", anyOf: ["fail", "failing", "stale", "freshness"] },
    ],
    mustNotInclude: [
      { label: "declares it healthy", anyOf: ["it's reliable", "fully reliable", "no issues", "all assertions pass"] },
    ],
  },

  /* ── Usage: real query volume beats catalog structure ────────────────── */
  {
    id: "payments-learn-first",
    category: "usage",
    question: "I just joined the Payments team. Which table should I learn first, and why that one?",
    stakes: "Ranking by what exists rather than what's queried wastes the first week on the wrong tables.",
    mustInclude: [
      { label: "picks a genuinely high-traffic table", anyOf: ["mrr_monthly", "fct_revenue"] },
      { label: "justifies with real query volume", anyOf: ["812", "743", "quer", "usage", "most-used"] },
    ],
    mustNotInclude: [
      { label: "leads with a low-traffic staging model", anyOf: ["start with stg_payments", "learn stg_payments first"] },
    ],
  },
  {
    id: "stg-payments-importance",
    category: "usage",
    question: "Is stg_payments an important table for me to know?",
    stakes: "It is a plumbing model with 19 queries in 30 days — important to understand, not to prioritize.",
    mustInclude: [
      { label: "characterizes it as staging/intermediate", anyOf: ["staging", "intermediate", "dbt", "plumbing"] },
      { label: "grounds in low usage or points to the fact table", anyOf: ["19", "low", "rarely", "fct_revenue"] },
    ],
  },

  /* ── Glossary: the org's definition, not the textbook one ────────────── */
  {
    id: "mrr-definition",
    category: "glossary",
    question: "How do we calculate MRR here?",
    stakes: "Every company defines MRR slightly differently; the catalog holds this one's definition.",
    mustInclude: [
      { label: "grounds in the catalog's MRR term or table", anyOf: ["mrr_monthly", "monthly_amount", "Monthly Recurring Revenue"] },
      { label: "relates it to a neighbouring term", anyOf: ["ARR", "Churn"] },
    ],
  },
  {
    id: "mrr-vs-arr",
    category: "glossary",
    question: "What's the difference between MRR and ARR in our metrics?",
    stakes: "ARR is a derived column, not a separate pipeline — worth knowing before rebuilding it.",
    mustInclude: [
      { label: "states the ×12 relationship", anyOf: ["12", "twelve", "annual"] },
      { label: "grounds in the real column or table", anyOf: ["arr_usd", "mrr_monthly"] },
    ],
  },

  /* ── SQL: the query analysts actually run ────────────────────────────── */
  {
    id: "churn-sql",
    category: "sql",
    question: "Show me the SQL people here use for churn analysis.",
    stakes: "There is a canonical saved query; re-deriving churn from subscriptions produces a different number.",
    mustInclude: [
      { label: "uses the churn fact table", anyOf: ["fct_churn"] },
      { label: "uses the real column", anyOf: ["churn_rate"] },
    ],
  },
  {
    id: "revenue-by-country-sql",
    category: "sql",
    question: "How do I pull net revenue by customer country?",
    stakes: "gross_amount_usd includes refunds; using it overstates revenue.",
    mustInclude: [
      { label: "uses the net column", anyOf: ["net_amount_usd"] },
      { label: "joins the customer dim", anyOf: ["dim_customers"] },
    ],
    mustNotInclude: [
      { label: "sums the gross column as revenue", anyOf: ["SUM(r.gross_amount_usd)", "SUM(gross_amount_usd)"] },
    ],
  },

  /* ── Hallucination resistance: say "not in the catalog" ──────────────── */
  {
    id: "fake-marketing-table",
    category: "hallucination",
    question: "What columns are in our marketing_attribution table?",
    stakes: "This table does not exist. Inventing a schema for it is the single most damaging failure mode.",
    mustInclude: [
      {
        label: "admits it is not in the catalog",
        anyOf: [
          "not in the catalog", "no marketing_attribution", "doesn't exist", "does not exist",
          "couldn't find", "could not find", "no dataset", "not find", "no results", "isn't in",
        ],
      },
    ],
    mustNotInclude: [
      { label: "invents a schema", anyOf: ["utm_source", "attribution_model", "touchpoint", "channel_id", "campaign_id"] },
    ],
  },
  {
    id: "fake-feature-store",
    category: "hallucination",
    question: "Who owns the ml_feature_store dataset?",
    stakes: "Confidently naming an owner for a nonexistent dataset sends someone chasing a ghost.",
    mustInclude: [
      {
        label: "admits it is not in the catalog",
        anyOf: [
          "not in the catalog", "no ml_feature_store", "doesn't exist", "does not exist",
          "couldn't find", "could not find", "no dataset", "not find", "no results", "isn't in",
        ],
      },
    ],
    mustNotInclude: [
      { label: "invents an owner", anyOf: ["owned by Sarah Chen", "owned by Priya", "owned by Mike", "the ML team owns"] },
    ],
  },
];

export const CATEGORIES: Category[] = [
  "grounding",
  "ownership",
  "lineage",
  "health-trap",
  "usage",
  "glossary",
  "sql",
  "hallucination",
];
