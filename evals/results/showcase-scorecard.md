# instaboard onboarding benchmark on the official DataHub datapack

_Generated 2026-08-02 18:49 UTC · model `nvidia/nemotron-3-ultra-550b-a55b:free` · catalog: live DataHub + showcase-ecommerce datapack_

20 questions a new hire asks in week 1, scored deterministically against
`showcase-ecommerce`, the demo datapack DataHub publishes (1,065 entities, authored by the DataHub team). Every arm runs through the identical agent loop; the only
difference is what is in the tool list.

> **Why this suite exists.** The Northbeam scorecard runs against a catalog this
> repo seeds, so a high grounded score there is, fairly, partly built in.
> This suite re-points the same questions at DataHub's own published
> `showcase-ecommerce` datapack: 1,065 entities across seven platforms that
> nobody here designed, loaded with one CLI command anyone can run. Every
> checked fact came out of that pack: owners, glossary definitions, retention
> periods, lineage edges.

> It is also a **harder** catalog. It is loaded alongside Northbeam, so the agent
> searches a warehouse with real collisions: two `orders` tables, six datasets
> called some form of `order_details`, `customers` in four platforms.

## Headline

| Arm | What it can see | Cases passed | Checks passed | Tool calls |
| --- | --- | --- | --- | --- |
| **With DataHub (MCP)** | the catalog: owners, glossary, health, deprecation, usage, lineage, saved queries | **20/20** | 39/39 | 78 |
| Warehouse schema only | table names, column names, column types — `information_schema` | 4/20 | 16/39 | 118 |
| No tools (control) | nothing; answers from model knowledge | 3/20 | 18/39 | 0 |

**17 of 20 onboarding questions are answerable only with the catalog.**

The middle arm is the one that makes this readable. It has real tools and makes real lookups against the same warehouse — it just cannot see anything the catalog adds on top of the schema. It scores **4/20**, putting **16 of 20** questions beyond the reach of a database connection alone. That gap is the metadata, not the tooling.

It is not that it tried less hard: it made 118 tool calls to the grounded arm's 78, and still finished 16 cases behind. Listing every table in the warehouse does not tell you which of six identically-named copies is the one people use, who to ask about it, or what the company means by "active user".

## By category

| Category | With DataHub | Warehouse schema only | No tools (control) |
| --- | --- | --- | --- |
| grounding | 3/3 | 0/3 | 0/3 |
| authority | 3/3 | 1/3 | 0/3 |
| ownership | 3/3 | 0/3 | 0/3 |
| lineage | 3/3 | 0/3 | 1/3 |
| glossary | 2/2 | 0/2 | 0/2 |
| governance | 4/4 | 1/4 | 2/4 |
| hallucination | 2/2 | 2/2 | 0/2 |

## Case detail

### `sc-order-details-canonical` — In the order-entry warehouse, which dataset gives me one wide row per order with the customer and product attributes already joined on? Give me its URN.

*Why it matters:* Six datasets in this catalog are called some form of order_details. Picking by name alone is a coin flip.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (0/2)
  - missed: names order_details
  - missed: cites a real analytics URN
- **No tools (control): FAIL** (0/2)
  - missed: names order_details
  - missed: cites a real analytics URN

### `sc-order-details-customer-columns` — Which columns on the order-entry ORDER_DETAILS table carry the customer's identity? I need to know what I'm selecting before I write the query.

*Why it matters:* Guessing column names produces a query that fails, or worse, silently selects the wrong field.

- **With DataHub: PASS** (4/4)
- **Warehouse schema only: FAIL** (0/4)
  - missed: names the email column
  - missed: names a real name column
  - missed: names the join key
  - missed: invents columns — found disqualifying text "full_name"
- **No tools (control): FAIL** (1/4)
  - missed: names the email column
  - missed: names a real name column
  - missed: invents columns — found disqualifying text "customer_name"

### `sc-order-history-grain` — What is ORDER_HISTORY in the order-entry analytics schema, and how is its grain different from ORDER_DETAILS?

*Why it matters:* ORDER_HISTORY is an incremental snapshot table. Joining it like a fact table double-counts every order.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: names the snapshot date column
- **No tools (control): FAIL** (1/2)
  - missed: names the snapshot date column

### `sc-replica-vs-canonical` — I found ORDER_DETAILS_REPLICA in the analytics schema and it has the same 55 columns as ORDER_DETAILS. Can I just build my report on the replica?

*Why it matters:* The replica is an unowned, ungoverned view. A report built on it has nobody to page when it breaks and no certification behind its numbers.

- **With DataHub: PASS** (3/3)
- **Warehouse schema only: FAIL** (2/3)
  - missed: grounds the verdict in real catalog metadata
- **No tools (control): FAIL** (2/3)
  - missed: grounds the verdict in real catalog metadata

### `sc-which-platform-authoritative` — order_details exists in Snowflake, dbt, Looker and PowerBI in this catalog. Which copy is the authoritative one, and what in DataHub tells you that?

*Why it matters:* Every downstream copy looks equally real in a search result. Only the catalog's governance metadata distinguishes them.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): FAIL** (1/2)
  - missed: cites the governance marker that settles it

### `sc-order-details-domain` — Which domain does the Snowflake ORDER_DETAILS table belong to? I need to know whose remit it is.

*Why it matters:* Domain ownership decides who reviews a schema change; guessing sends the request to the wrong team.

- **With DataHub: PASS** (1/1)
- **Warehouse schema only: FAIL** (0/1)
  - missed: names the real domain
- **No tools (control): FAIL** (0/1)
  - missed: names the real domain

### `sc-order-details-stewards` — Who are the data stewards for the Snowflake ORDER_DETAILS table?

*Why it matters:* Governance questions go to the steward, not the technical owner. Inventing a name costs credibility.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: names a real steward
- **No tools (control): FAIL** (1/2)
  - missed: names a real steward

### `sc-escalation-contact` — ORDER_DETAILS hasn't refreshed and it's blocking my report. Who is the escalation contact for it according to the catalog?

*Why it matters:* The escalation contact lives in a structured property rather than the ownership list, so an agent that only reads owners gets this wrong.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: names the escalation contact
- **No tools (control): FAIL** (1/2)
  - missed: names the escalation contact

### `sc-powerbi-order-details-owner` — Who owns the PowerBI ORDER_DETAILS dataset in the datahub_order_entries workspace?

*Why it matters:* The BI-layer copy has a different owner from the warehouse table. Answering with the warehouse owner sends you to the wrong person.

- **With DataHub: PASS** (1/1)
- **Warehouse schema only: FAIL** (0/1)
  - missed: names the PowerBI owner
- **No tools (control): FAIL** (0/1)
  - missed: names the PowerBI owner

### `sc-order-details-downstream` — What breaks if I drop a column from the Snowflake ORDER_DETAILS table? Give me the actual downstream dependents.

*Why it matters:* ORDER_DETAILS feeds the Looker view, the PowerBI model and three dashboards. Shipping blind takes all of them out.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (0/2)
  - missed: names a BI-layer dependent
  - missed: names a downstream dataset or dashboard
- **No tools (control): PASS** (2/2)

### `sc-order-details-upstream` — Where does the Snowflake ORDER_DETAILS table get its data from? I'm debugging a wrong total.

*Why it matters:* Debugging starts at the real inputs. Without lineage the new hire reads the model SQL and guesses.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (0/2)
  - missed: names the line-item source
  - missed: names another real upstream
- **No tools (control): FAIL** (1/2)
  - missed: names the line-item source

### `sc-dashboard-blast-radius` — Which dashboards are built on the order-entry data? I want to know who to warn before a migration.

*Why it matters:* Three dashboards across three BI tools sit on this data; missing one means a stakeholder finds out from a broken chart.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: names a real dashboard
- **No tools (control): FAIL** (1/2)
  - missed: names a real dashboard

### `sc-order-total-definition` — How is 'Order Total' defined in our glossary, and how am I supposed to compute it?

*Why it matters:* The glossary term carries the sanctioned SQL. Re-deriving order value from line items produces a number finance will dispute.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: gives the sanctioned aggregation
- **No tools (control): FAIL** (1/2)
  - missed: gives the sanctioned aggregation

### `sc-revenue-by-customer-class` — What does 'Revenue by Customer Class' mean here, and which columns do I group by?

*Why it matters:* The term names the exact grouping column; guessing 'segment' or 'tier' returns nothing.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: names the measure
- **No tools (control): FAIL** (1/2)
  - missed: names the grouping column

### `sc-pii-columns` — Which columns on ORDER_DETAILS are classified as personal data, and what does that mean for how I use them?

*Why it matters:* PII classification is column-level here. Exporting cust_email into a spreadsheet is a compliance incident, not a style question.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: names a PII-classified column
- **No tools (control): FAIL** (1/2)
  - missed: names a PII-classified column

### `sc-retention-period` — How long is ORDER_DETAILS retained for? I need to know before I promise a two-year trend report.

*Why it matters:* Retention is a structured property, invisible unless you read it. A two-year report on a one-year table is a promise you can't keep.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (0/2)
  - missed: states the real retention period
  - missed: grounds it in the retention property
- **No tools (control): FAIL** (1/2)
  - missed: states the real retention period

### `sc-soc2-scope` — Is ORDER_DETAILS in scope for a SOC 2 audit?

*Why it matters:* In-scope datasets carry audit obligations. Answering from intuition rather than the glossary term is a guess.

- **With DataHub: PASS** (1/1)
- **Warehouse schema only: PASS** (1/1)
- **No tools (control): PASS** (1/1)

### `sc-cost-center` — Which cost centre is charged for the Snowflake ORDER_DETAILS table?

*Why it matters:* Chargeback questions come up in every platform review. This is recorded in the catalog and nowhere else a new hire can find.

- **With DataHub: PASS** (1/1)
- **Warehouse schema only: FAIL** (0/1)
  - missed: names the real cost centre
- **No tools (control): PASS** (1/1)

### `sc-fake-shipment-tracking` — What columns are in the shipment_tracking table?

*Why it matters:* There is no shipment_tracking dataset in this catalog. An e-commerce catalog makes a plausible-sounding schema very easy to invent.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): FAIL** (0/2)
  - missed: admits it is not in the catalog
  - missed: invents a schema — found disqualifying text "tracking_number"

### `sc-fake-churn-predictions` — Who owns the customer_churn_predictions dataset, and how often does it refresh?

*Why it matters:* Confidently naming an owner and a schedule for a dataset that doesn't exist sends someone chasing a ghost for a day.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): FAIL** (1/2)
  - missed: admits it is not in the catalog

## Method

- **Scoring is deterministic.** Every check is a case-insensitive substring match
  against the agent's final answer. There is no LLM judge and no partial credit —
  a case passes only if all of its checks pass. Raw answers for every case are in
  `showcase-latest.json` so any check can be verified by hand.
- **All three arms share one code path** (`runAgent` in `lib/agent.ts`). The control
  arm is the same loop with `tools: []`; the schema arm is the same loop pointed at
  `lib/warehouse-introspection.ts` instead of the MCP server.
- **Neither control is a strawman.** The no-tools arm gets a neutral,
  capable-assistant prompt asking for specific tables, owners and SQL — the
  counterfactual is an off-the-shelf chatbot, not a crippled one. The schema arm is
  told to look everything up and never guess at a name it has not seen. All three
  prompts are in `suites.ts`.
- **The schema arm reads the same catalog**, stripped to what a warehouse connection
  would return: table names, column names, column types. Sourcing it separately would
  make its lower score an artifact of the harness rather than a finding about
  metadata.
- **Runs on a free API tier.** A full run is ~120 LLM calls across three arms, more
  than most free daily quotas allow at once, so each completed case is cached and a
  re-run resumes where it stopped. A score may therefore be assembled across
  sessions — always on the one model named above, never mixed.
- **Reproduce:** this suite runs only against live DataHub, because the catalog
  it checks is not ours to fixture:

  ```bash
  npm run datahub:up
  datahub datapack load showcase-ecommerce   # DataHub's own demo pack
  npm run eval -- --live --suite=showcase
  ```

- **Nothing here was authored by instaboard.** Every table, owner, glossary
  definition, structured property and lineage edge checked above came out of
  the datapack. The questions were written against facts read back from the
  live catalog after loading it.
