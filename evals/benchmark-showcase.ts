/**
 * The instaboard onboarding benchmark, run on the official DataHub datapack.
 *
 * The Northbeam benchmark (`benchmark.ts`) has one honest weakness: instaboard's
 * author seeded that catalog. A high grounded-arm score on a catalog you built,
 * answering questions you wrote, is partly true by construction.
 *
 * This suite removes that objection. Every fact checked below lives in
 * **`showcase-ecommerce`**, the demo datapack DataHub publishes. It holds 1,065
 * entities: 67 datasets spread over Snowflake, dbt, Postgres, S3, Looker, PowerBI
 * and Tableau, plus 873 schema fields, 23 Spark jobs, 3 dashboards, 5 data
 * products, 13 glossary terms and 5 structured properties. The DataHub team wrote
 * all of it. Load it with:
 *
 *     datahub datapack load showcase-ecommerce
 *     npm run eval -- --live --suite=showcase
 *
 * The questions are the same week-one questions, re-pointed at that catalog. The
 * scoring method is unchanged: deterministic substring checks, no LLM judge, no
 * partial credit.
 *
 * Two things this suite leaves out, and why.
 *
 * 1. **No usage or assertion categories.** The datapack keeps its usage stats and
 *    assertion rollups in aspects that only exist in DataHub Cloud, namely
 *    `usageFeatures`, `assertionsSummary` and `lineageFeatures`. Load it into an
 *    OSS quickstart and 248 of its 3,809 MCPs get dropped, leaving no query volume
 *    or assertion state on the server for a question to lean on. Inventing some
 *    would defeat the point, so `usage` and `health-trap` give way to two
 *    categories the official catalog does support: `authority`, which asks which of
 *    six same-named copies is the real one, and `governance`, covering retention,
 *    PII classification, SOC 2 scope and cost centre, all read from structured
 *    properties the pack carries.
 * 2. **Nobody tidied the catalog for us.** The showcase datapack loads alongside
 *    Northbeam in the same DataHub, so the agent is searching against real
 *    collisions: two `orders` tables, six `order_details`, a `customers` in four
 *    platforms. That makes this suite harder than the Northbeam one, and the
 *    scores below carry the consequence.
 */

import type { EvalCase } from "./benchmark";

export type ShowcaseCategory =
  | "grounding"
  | "authority"
  | "ownership"
  | "lineage"
  | "glossary"
  | "governance"
  | "hallucination";

export const SHOWCASE_CATEGORIES: ShowcaseCategory[] = [
  "grounding",
  "authority",
  "ownership",
  "lineage",
  "glossary",
  "governance",
  "hallucination",
];

/** Real URNs copied out of the datapack rather than reconstructed. */
const SF_ORDER_DETAILS =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)";
const DBT_ORDER_DETAILS =
  "urn:li:dataset:(urn:li:dataPlatform:dbt,b2fd91.ORDER_ENTRY_DB.analytics.order_details,PROD)";

export const SHOWCASE_BENCHMARK: EvalCase<ShowcaseCategory>[] = [
  /* ── Grounding: name the real entity in a catalog you didn't design ──── */
  {
    id: "sc-order-details-canonical",
    category: "grounding",
    question:
      "In the order-entry warehouse, which dataset gives me one wide row per order with the customer and product attributes already joined on? Give me its URN.",
    stakes:
      "Six datasets in this catalog are called some form of order_details. Picking by name alone is a coin flip.",
    mustInclude: [
      { label: "names order_details", anyOf: ["order_details", "ORDER_DETAILS"] },
      { label: "cites a real analytics URN", anyOf: [SF_ORDER_DETAILS, DBT_ORDER_DETAILS] },
    ],
  },
  {
    id: "sc-order-details-customer-columns",
    category: "grounding",
    question:
      "Which columns on the order-entry ORDER_DETAILS table carry the customer's identity? I need to know what I'm selecting before I write the query.",
    stakes: "Guessing column names produces a query that fails, or worse, silently selects the wrong field.",
    mustInclude: [
      { label: "names the email column", anyOf: ["cust_email"] },
      { label: "names a real name column", anyOf: ["cust_first_name", "cust_last_name"] },
      { label: "names the join key", anyOf: ["customer_id"] },
    ],
    mustNotInclude: [
      { label: "invents columns", anyOf: ["customer_name", "email_address", "cust_name", "full_name"] },
    ],
  },
  {
    id: "sc-order-history-grain",
    category: "grounding",
    question:
      "What is ORDER_HISTORY in the order-entry analytics schema, and how is its grain different from ORDER_DETAILS?",
    stakes:
      "ORDER_HISTORY is an incremental snapshot table. Joining it like a fact table double-counts every order.",
    mustInclude: [
      { label: "names the snapshot date column", anyOf: ["as_of_date"] },
      {
        label: "characterizes it as historical/incremental snapshots",
        anyOf: ["incremental", "historical", "history", "snapshot", "as-of", "point in time", "point-in-time"],
      },
    ],
  },

  /* ── Authority: which of the six same-named copies is the real one? ──── */
  {
    id: "sc-replica-vs-canonical",
    category: "authority",
    question:
      "I found ORDER_DETAILS_REPLICA in the analytics schema and it has the same 55 columns as ORDER_DETAILS. Can I just build my report on the replica?",
    stakes:
      "The replica is an unowned, ungoverned view. A report built on it has nobody to page when it breaks and no certification behind its numbers.",
    mustInclude: [
      { label: "steers to ORDER_DETAILS instead", anyOf: ["ORDER_DETAILS", "order_details"] },
      {
        label: "grounds the verdict in real catalog metadata",
        anyOf: [
          "Most Queried",
          "Authoritative Source",
          "Certified",
          "Data Steward",
          "David Kim",
          "Julia Novak",
          "no owner",
          "no owners",
          "unowned",
          "not owned",
          "lacks owner",
          "no glossary",
          "no tags",
          "no domain",
        ],
      },
    ],
    mustNotInclude: [
      {
        label: "endorses the replica",
        anyOf: [
          "yes, you can build",
          "yes, you can build",
          "safe to build on the replica",
          "use ORDER_DETAILS_REPLICA",
          "recommend ORDER_DETAILS_REPLICA",
        ],
      },
    ],
  },
  {
    id: "sc-which-platform-authoritative",
    category: "authority",
    question:
      "order_details exists in Snowflake, dbt, Looker and PowerBI in this catalog. Which copy is the authoritative one, and what in DataHub tells you that?",
    stakes:
      "Every downstream copy looks equally real in a search result. Only the catalog's governance metadata distinguishes them.",
    mustInclude: [
      {
        label: "cites the governance marker that settles it",
        anyOf: ["Authoritative Source", "Certified", "Most Queried", "Data Quality Score"],
      },
      { label: "names a specific platform copy", anyOf: ["dbt", "Snowflake", "snowflake"] },
    ],
  },
  {
    id: "sc-order-details-domain",
    category: "authority",
    question: "Which domain does the Snowflake ORDER_DETAILS table belong to? I need to know whose remit it is.",
    stakes: "Domain ownership decides who reviews a schema change; guessing sends the request to the wrong team.",
    mustInclude: [{ label: "names the real domain", anyOf: ["Ecommerce Operations", "E-Commerce Operations"] }],
  },

  /* ── Ownership: real people, from the real ownership aspect ──────────── */
  {
    id: "sc-order-details-stewards",
    category: "ownership",
    question: "Who are the data stewards for the Snowflake ORDER_DETAILS table?",
    stakes: "Governance questions go to the steward, not the technical owner. Inventing a name costs credibility.",
    mustInclude: [{ label: "names a real steward", anyOf: ["David Kim", "Julia Novak"] }],
    mustNotInclude: [
      { label: "invents an owner", anyOf: ["John Smith", "Jane Doe", "the data team owns", "no owner is listed"] },
    ],
  },
  {
    id: "sc-escalation-contact",
    category: "ownership",
    question:
      "ORDER_DETAILS hasn't refreshed and it's blocking my report. Who is the escalation contact for it according to the catalog?",
    stakes:
      "The escalation contact lives in a structured property rather than the ownership list, so an agent that only reads owners gets this wrong.",
    mustInclude: [
      { label: "names the escalation contact", anyOf: ["EMP006", "Ian Chen"] },
      { label: "grounds it in the escalation property", anyOf: ["escalation", "Escalation"] },
    ],
  },
  {
    id: "sc-powerbi-order-details-owner",
    category: "ownership",
    question: "Who owns the PowerBI ORDER_DETAILS dataset in the datahub_order_entries workspace?",
    stakes:
      "The BI-layer copy has a different owner from the warehouse table. Answering with the warehouse owner sends you to the wrong person.",
    mustInclude: [{ label: "names the PowerBI owner", anyOf: ["Karen Okonkwo"] }],
  },

  /* ── Lineage: the graph the datapack actually holds ──────────────────── */
  {
    id: "sc-order-details-downstream",
    category: "lineage",
    question:
      "What breaks if I drop a column from the Snowflake ORDER_DETAILS table? Give me the actual downstream dependents.",
    stakes:
      "ORDER_DETAILS feeds the Looker view, the PowerBI model and three dashboards. Shipping blind takes all of them out.",
    mustInclude: [
      { label: "names a BI-layer dependent", anyOf: ["Looker", "looker", "PowerBI", "Power BI", "powerbi", "Tableau", "tableau"] },
      { label: "names a downstream dataset or dashboard", anyOf: ["ORDER_HISTORY", "order_history", "dashboard", "Dashboard"] },
    ],
  },
  {
    id: "sc-order-details-upstream",
    category: "lineage",
    question: "Where does the Snowflake ORDER_DETAILS table get its data from? I'm debugging a wrong total.",
    stakes: "Debugging starts at the real inputs. Without lineage the new hire reads the model SQL and guesses.",
    mustInclude: [
      { label: "names the line-item source", anyOf: ["order_items", "ORDER_ITEMS"] },
      {
        label: "names another real upstream",
        anyOf: ["addresses", "ADDRESSES", "countries", "COUNTRIES", "warehouses", "WAREHOUSES", "promotions", "PROMOTIONS", "inventories", "INVENTORIES", "products", "PRODUCTS", "customers", "CUSTOMERS"],
      },
    ],
  },
  {
    id: "sc-dashboard-blast-radius",
    category: "lineage",
    question: "Which dashboards are built on the order-entry data? I want to know who to warn before a migration.",
    stakes: "Three dashboards across three BI tools sit on this data; missing one means a stakeholder finds out from a broken chart.",
    mustInclude: [
      { label: "names a real dashboard", anyOf: ["Order Entry Dashboard", "datahub_order_entries"] },
      { label: "identifies the BI platform", anyOf: ["Tableau", "tableau", "Looker", "looker", "PowerBI", "Power BI", "powerbi"] },
    ],
  },

  /* ── Glossary: this catalog's definitions, with their SQL ────────────── */
  {
    id: "sc-order-total-definition",
    category: "glossary",
    question: "How is 'Order Total' defined in our glossary, and how am I supposed to compute it?",
    stakes:
      "The glossary term carries the sanctioned SQL. Re-deriving order value from line items produces a number finance will dispute.",
    mustInclude: [
      { label: "uses the real column", anyOf: ["order_total"] },
      { label: "gives the sanctioned aggregation", anyOf: ["SUM(order_total", "SUM(ORDER_TOTAL", "sum(order_total"] },
    ],
  },
  {
    id: "sc-revenue-by-customer-class",
    category: "glossary",
    question: "What does 'Revenue by Customer Class' mean here, and which columns do I group by?",
    stakes: "The term names the exact grouping column; guessing 'segment' or 'tier' returns nothing.",
    mustInclude: [
      { label: "names the grouping column", anyOf: ["customer_class"] },
      { label: "names the measure", anyOf: ["order_total"] },
    ],
  },

  /* ── Governance: structured properties and classification ────────────── */
  {
    id: "sc-pii-columns",
    category: "governance",
    question:
      "Which columns on ORDER_DETAILS are classified as personal data, and what does that mean for how I use them?",
    stakes:
      "PII classification is column-level here. Exporting cust_email into a spreadsheet is a compliance incident, not a style question.",
    mustInclude: [
      { label: "names a PII-classified column", anyOf: ["cust_email", "phone_number", "cust_first_name", "cust_last_name"] },
      { label: "cites the classification", anyOf: ["PII", "Email Address", "Phone Number", "personally identifiable"] },
    ],
  },
  {
    id: "sc-retention-period",
    category: "governance",
    question: "How long is ORDER_DETAILS retained for? I need to know before I promise a two-year trend report.",
    stakes:
      "Retention is a structured property, invisible unless you read it. A two-year report on a one-year table is a promise you can't keep.",
    mustInclude: [
      { label: "states the real retention period", anyOf: ["1 year", "one year"] },
      { label: "grounds it in the retention property", anyOf: ["Retention", "retention"] },
    ],
  },
  {
    id: "sc-soc2-scope",
    category: "governance",
    question: "Is ORDER_DETAILS in scope for a SOC 2 audit?",
    stakes: "In-scope datasets carry audit obligations. Answering from intuition rather than the glossary term is a guess.",
    mustInclude: [{ label: "cites the SOC 2 term", anyOf: ["SOC2 Auditable", "SOC 2 Auditable", "SOC2", "SOC 2"] }],
  },
  {
    id: "sc-cost-center",
    category: "governance",
    question: "Which cost centre is charged for the Snowflake ORDER_DETAILS table?",
    stakes:
      "Chargeback questions come up in every platform review. This is recorded in the catalog and nowhere else a new hire can find.",
    mustInclude: [{ label: "names the real cost centre", anyOf: ["Marketing"] }],
  },

  /* ── Hallucination resistance on an unfamiliar catalog ───────────────── */
  {
    id: "sc-fake-shipment-tracking",
    category: "hallucination",
    question: "What columns are in the shipment_tracking table?",
    stakes:
      "There is no shipment_tracking dataset in this catalog. An e-commerce catalog makes a plausible-sounding schema very easy to invent.",
    mustInclude: [
      {
        label: "admits it is not in the catalog",
        anyOf: [
          "not in the catalog", "no shipment_tracking", "doesn't exist", "does not exist",
          "couldn't find", "could not find", "no dataset", "not find", "no results", "isn't in",
          "no such", "not present", "no table named", "there is no", "no entity named",
        ],
      },
    ],
    mustNotInclude: [
      {
        label: "invents a schema",
        anyOf: ["tracking_number", "carrier_id", "shipped_at", "tracking_id", "delivery_status", "carrier_name"],
      },
    ],
  },
  {
    id: "sc-fake-churn-predictions",
    category: "hallucination",
    question: "Who owns the customer_churn_predictions dataset, and how often does it refresh?",
    stakes:
      "Confidently naming an owner and a schedule for a dataset that doesn't exist sends someone chasing a ghost for a day.",
    mustInclude: [
      {
        label: "admits it is not in the catalog",
        anyOf: [
          "not in the catalog", "no customer_churn_predictions", "doesn't exist", "does not exist",
          "couldn't find", "could not find", "no dataset", "not find", "no results", "isn't in",
          "no such", "not present", "no table named", "there is no", "no entity named",
        ],
      },
    ],
    mustNotInclude: [
      {
        label: "invents an owner",
        anyOf: ["owned by David Kim", "owned by Julia Novak", "owned by Ian Chen", "the ML team owns", "the data science team owns"],
      },
    ],
  },
];
