# datahub-onboarding

Onboard new data-team members and capture departing members' knowledge as living,
catalog-validated documents in DataHub.

## What it does

1. Orients a new team member in an unfamiliar catalog: maps the domain, ranks datasets by
   real 30-day usage, flags deprecated tables (and names their replacements), identifies
   the actual owners to talk to, and surfaces glossary definitions and real saved queries.
2. Builds a "week one" learning path for a specific role and domain, grounded in usage
   stats and dataset health, and saves it back to DataHub as a document linked to the
   datasets it covers.
3. Captures a departing member's task knowledge as a runbook — dataset URN, action, and
   the *why* for every step — enriched from the live catalog with owners, schema, real
   SQL, and lineage, then saved back to DataHub.
4. Re-validates any runbook or onboarding document on read-back with deterministic checks
   (columns still exist, dataset not deprecated, assertions passing, owners unchanged) and
   warns before anyone follows a stale step.

## Capabilities

- Usage-ranked dataset recommendations (`get_usage_stats`) — never "the table with the
  best-sounding name"
- Deprecation and health guardrails (`get_dataset_health`) with named replacements
- Owner and glossary-term discovery (`get_entities`) for people and vocabulary
- Real recorded SQL (`get_dataset_queries`) — never invented queries
- Runbook enrichment with schema, ownership, and one-hop lineage (`get_lineage`)
- Write-back to the catalog (`save_document`) linked to referenced datasets
- Deterministic staleness detection on every document read-back
- `datahub` CLI fallback when the MCP server is unavailable

## Usage

```
/catalog-onboarding analytics engineer joining the revenue domain
/catalog-onboarding build a week-one learning path for a data scientist on the growth team
/catalog-onboarding capture Dana's monthly revenue close process as a runbook before she leaves
/catalog-onboarding is the "Monthly Revenue Close" runbook still accurate?
```
