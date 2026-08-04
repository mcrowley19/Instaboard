# datahub-onboarding

Onboard new data-team members and capture departing members' knowledge as living,
catalog-validated documents in DataHub.

## What it does

1. Orients a new team member in an unfamiliar catalog. It maps the domain, works out which
   of the same-named copies of a table is the canonical one, flags deprecated tables and
   names their replacements from the deprecation note, finds the owners and the escalation
   contact to talk to, and surfaces glossary definitions along with real recorded queries.
2. Builds a "week one" learning path for a specific role and domain, grounded in the
   catalog's own certification, ownership and health metadata, and saves it back to DataHub
   as a document linked to the datasets it covers.
3. Captures a departing member's task knowledge as a runbook. Every step carries a dataset
   URN, an action and the _why_, enriched from the live catalog with owners, schema, real
   SQL and lineage, then saved back to DataHub.
4. Re-validates any runbook or onboarding document on read-back with deterministic checks
   (columns still exist, dataset not deprecated since, health not failing, owners unchanged)
   and warns before anyone follows a stale step. Each claim is pinned to the version of the
   catalog aspect it was checked against, so anyone can reproduce a verdict for
   themselves.
5. Writes the staleness back as state a person will walk into: a `StaleRunbook` tag, the
   status and the specific breaking change as structured properties, an assertion that fails
   while the runbook is stale, and an incident assigned to whoever owns the dataset today.
6. Proposes whatever correction the catalog supports, so the renamed column, the
   replacement named in a deprecation note, the current owner, as a diff for a human to
   approve. It also names what it deliberately left alone.

## Capabilities

- Works out which copy is canonical from certification markers, ownership coverage, usage
  tags and lineage position (`search`, `get_entities`), so nobody has to fall back on "the
  table with the best-sounding name"
- Guards on deprecation and health, read off the entity's `deprecation` and `health`
  fields, naming the replacement from the deprecation note
- Finds owners, escalation contacts and glossary terms (`get_entities`, including
  `structuredProperties`), which covers people, SLAs and vocabulary
- Serves real recorded SQL (`get_dataset_queries`), never an invented query, and says "no
  recorded queries" outright when the catalog has none
- Enriches a runbook with schema, ownership and one-hop lineage (`get_lineage`)
- Writes back to the catalog (`save_document`), linked to the datasets referenced, and
  reports the document URN
- Checks for staleness deterministically on every document read-back, one claim at a time,
  each pinned to a recomputable fingerprint of the aspect it depends on
- A third verdict state for what could not be checked, with coverage tracked as its own
  figure. An unmonitored dataset cannot answer "is this healthy?", and reporting it as
  clean is the one failure a validator must not have
- Writes staleness back as catalog state: a tag, structured properties, an assertion on
  whether the runbook is valid, and an incident assigned to the dataset's current owner
- Retracts all of it when the document is repaired, so the incident is resolved, the
  assertion passes and the tag comes off, guarded against another document still stale on
  the same dataset
- Proposes catalog-derived corrections as a reviewable diff, carrying the evidence for each
  edit and an explicit list of what needs a person
- Falls back to the `datahub` CLI when the MCP server is unavailable, including
  `datasetUsageStatistics` for raw query volume, which no MCP tool currently exposes

## Usage

```text
/catalog-onboarding analytics engineer joining the revenue domain
/catalog-onboarding build a week-one learning path for a data scientist on the growth team
/catalog-onboarding capture Dana's monthly revenue close process as a runbook before she leaves
/catalog-onboarding is the "Monthly Revenue Close" runbook still accurate?
/catalog-onboarding the revenue close runbook is stale, record it in the catalog and show me the fix
```
