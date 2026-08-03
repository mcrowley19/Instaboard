# instaboard onboarding benchmark

_Generated 2026-08-03 13:58 UTC · catalog: demo catalog (fixture)_
_model `nvidia/nemotron-3-ultra-550b-a55b:free` · 1 run per case_

20 questions a new hire asks in week 1, scored deterministically against
Northbeam, seeded by this repo with `npm run seed`. Every arm runs through the identical agent loop; the only
difference is what is in the tool list.

## Headline

| Arm | What it can see | Cases passed | Checks passed | Tool calls |
| --- | --- | --- | --- | --- |
| **With DataHub (MCP)** | the catalog: owners, glossary, health, deprecation, usage, lineage, saved queries | **19/20** | 43/44 | 86 |
| Warehouse schema only | table names, column names, column types — `information_schema` | 9/20 | 30/44 | 111 |
| No tools (control) | nothing; answers from model knowledge | 5/20 | 21/44 | 0 |

**14 of 20 onboarding questions are answerable only with the catalog.**

The middle arm is the one that makes this readable. It has real tools and makes real lookups against the same warehouse — it just cannot see anything the catalog adds on top of the schema. It scores **9/20**, putting **10 of 20** questions beyond the reach of a database connection alone. That gap is the metadata, not the tooling.

It is not that it tried less hard: it made 111 tool calls per pass to the grounded arm's 86, and still finished 10 cases behind. Listing every table in the warehouse does not tell you which of six identically-named copies is the one people use, who to ask about it, or what the company means by "active user".

## By category

| Category | With DataHub | Warehouse schema only | No tools (control) |
| --- | --- | --- | --- |
| grounding | 2/3 | 0/3 | 0/3 |
| ownership | 2/2 | 0/2 | 0/2 |
| lineage | 3/3 | 2/3 | 0/3 |
| health-trap | 4/4 | 2/4 | 2/4 |
| usage | 2/2 | 0/2 | 1/2 |
| glossary | 2/2 | 1/2 | 1/2 |
| sql | 2/2 | 2/2 | 0/2 |
| hallucination | 2/2 | 2/2 | 1/2 |

## Case detail

### `revenue-tables` — What tables do we use for revenue?

*Why it matters:* A new hire who queries the wrong revenue table reports numbers finance will contradict.

- **With DataHub: PASS** (4/4)
- **Warehouse schema only: FAIL** (3/4)
  - missed: cites a real URN
- **No tools (control): FAIL** (1/4)
  - missed: names fct_revenue
  - missed: names the MRR rollup
  - missed: cites a real URN

### `mrr-computed-where` — Where is MRR actually computed? I need the table the board deck reads from.

*Why it matters:* Recomputing MRR by hand from payments is the classic new-hire mistake that produces a second, wrong number.

- **With DataHub: PASS** (3/3)
- **Warehouse schema only: FAIL** (1/3)
  - missed: names its upstream fact
  - missed: cites the URN
- **No tools (control): FAIL** (1/3)
  - missed: names its upstream fact
  - missed: cites the URN

### `customer-id-definition` — How is customer_id defined, and which table is the source of truth for customers?

*Why it matters:* Joining on the wrong customer key silently drops or fans out rows.

- **With DataHub: FAIL** (1/2)
  - missed: cites the URN
- **Warehouse schema only: FAIL** (1/2)
  - missed: cites the URN
- **No tools (control): FAIL** (1/2)
  - missed: cites the URN

### `payments-owner` — Who owns the payments pipeline? I need to ask about a discrepancy.

*Why it matters:* Messaging the wrong person costs a day; inventing a person costs credibility.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: names Priya Patel
- **No tools (control): FAIL** (1/2)
  - missed: names Priya Patel

### `growth-owner` — Who should I ask about the product events data?

*Why it matters:* Growth data has a specific owner; a generic answer sends the new hire to a dead end.

- **With DataHub: PASS** (1/1)
- **Warehouse schema only: FAIL** (0/1)
  - missed: names James Okafor
- **No tools (control): FAIL** (0/1)
  - missed: names James Okafor

### `email-blast-radius` — What breaks if I change the email column on the users table?

*Why it matters:* Shipping a column change without the downstream list is how a mart silently breaks overnight.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (0/2)
  - missed: names the staging model
  - missed: names the downstream dim
- **No tools (control): FAIL** (1/2)
  - missed: names the downstream dim

### `fct-revenue-upstream` — Where does fct_revenue get its data from?

*Why it matters:* Debugging a revenue discrepancy starts with knowing the three real inputs, not guessing.

- **With DataHub: PASS** (3/3)
- **Warehouse schema only: PASS** (3/3)
- **No tools (control): FAIL** (0/3)
  - missed: names stg_payments
  - missed: names orders
  - missed: names refunds

### `mrr-debug-upstream` — The MRR number looks wrong this month. What should I check upstream?

*Why it matters:* Without lineage the new hire debugs the rollup instead of the fact table that feeds it.

- **With DataHub: PASS** (1/1)
- **Warehouse schema only: PASS** (1/1)
- **No tools (control): FAIL** (0/1)
  - missed: points at fct_revenue

### `deprecated-events-trap` — Is it safe to build a new engagement report on the raw events table?

*Why it matters:* events is deprecated. Building on it means rebuilding the report in a month.

- **With DataHub: PASS** (3/3)
- **Warehouse schema only: FAIL** (2/3)
  - missed: flags it as deprecated
- **No tools (control): FAIL** (1/3)
  - missed: flags it as deprecated
  - missed: points to the replacement

### `active-users-table` — I need to count 28-day active users. Which table should I query?

*Why it matters:* The obvious answer (raw events) is the deprecated one; only the catalog knows that.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): FAIL** (1/2)
  - missed: routes to events_sessionized

### `payments-open-incident` — Any reason to be careful using the payments table right now?

*Why it matters:* There is an open incident producing duplicate rows. Not knowing means double-counted revenue.

- **With DataHub: PASS** (1/1)
- **Warehouse schema only: FAIL** (0/1)
  - missed: surfaces the open incident
- **No tools (control): PASS** (1/1)

### `payment-health-freshness` — Is payment_health_daily reliable right now? I want to use it for an on-call check.

*Why it matters:* Its freshness assertion is failing — the data is stale and the on-call check would be misleading.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): PASS** (2/2)

### `payments-learn-first` — I just joined the Payments team. Which table should I learn first, and why that one?

*Why it matters:* Ranking by what exists rather than what's queried wastes the first week on the wrong tables.

- **With DataHub: PASS** (3/3)
- **Warehouse schema only: FAIL** (2/3)
  - missed: picks a genuinely high-traffic table
- **No tools (control): FAIL** (2/3)
  - missed: picks a genuinely high-traffic table

### `stg-payments-importance` — Is stg_payments an important table for me to know?

*Why it matters:* It is a plumbing model with 19 queries in 30 days — important to understand, not to prioritize.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (1/2)
  - missed: grounds in low usage or points to the fact table
- **No tools (control): PASS** (2/2)

### `mrr-definition` — How do we calculate MRR here?

*Why it matters:* Every company defines MRR slightly differently; the catalog holds this one's definition.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: FAIL** (0/2)
  - missed: grounds in the catalog's MRR term or table
  - missed: relates it to a neighbouring term
- **No tools (control): FAIL** (1/2)
  - missed: grounds in the catalog's MRR term or table

### `mrr-vs-arr` — What's the difference between MRR and ARR in our metrics?

*Why it matters:* ARR is a derived column, not a separate pipeline — worth knowing before rebuilding it.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): PASS** (2/2)

### `churn-sql` — Show me the SQL people here use for churn analysis.

*Why it matters:* There is a canonical saved query; re-deriving churn from subscriptions produces a different number.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): FAIL** (0/2)
  - missed: uses the churn fact table
  - missed: uses the real column

### `revenue-by-country-sql` — How do I pull net revenue by customer country?

*Why it matters:* gross_amount_usd includes refunds; using it overstates revenue.

- **With DataHub: PASS** (3/3)
- **Warehouse schema only: PASS** (3/3)
- **No tools (control): FAIL** (2/3)
  - missed: uses the net column

### `fake-marketing-table` — What columns are in our marketing_attribution table?

*Why it matters:* This table does not exist. Inventing a schema for it is the single most damaging failure mode.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): FAIL** (0/2)
  - missed: admits it is not in the catalog
  - missed: invents a schema — found disqualifying text "attribution_model"

### `fake-feature-store` — Who owns the ml_feature_store dataset?

*Why it matters:* Confidently naming an owner for a nonexistent dataset sends someone chasing a ghost.

- **With DataHub: PASS** (2/2)
- **Warehouse schema only: PASS** (2/2)
- **No tools (control): PASS** (2/2)

## Method

- **Scoring is deterministic.** Every check is a case-insensitive substring match
  against the agent's final answer. There is no LLM judge and no partial credit —
  a case passes only if all of its checks pass. Raw answers for every pass are in
  `latest.json` so any check can be verified by hand.
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
- **Reproduce:** `DEMO_MODE=true npm run eval`, which needs neither DataHub nor Docker.
  Add `--live` to run the same benchmark against a seeded DataHub instance,
  or `--concurrency=1` if your provider is strict about requests per minute.
