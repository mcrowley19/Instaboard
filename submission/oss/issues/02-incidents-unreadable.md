# Incidents are unreadable over MCP: `get_entities` errors on incident URNs, and health reports `causes: ["ACTIVE_INCIDENTS"]` instead of URNs

**Repo:** `acryldata/mcp-server-datahub`
**Version:** `mcp-server-datahub` 0.6.0 (via `uvx mcp-server-datahub@latest`), GMS v1.5.0.6 (OSS quickstart)

> Related but distinct from #136, #143, #145 and #153, which all ask for incident **write**
> tools. This is about **reading** an incident that already exists. Even with write tools
> added, an agent still could not read back what it or anyone else raised.

---

## Summary

An agent can learn from `get_entities` that a dataset has an active incident, but cannot
learn anything about it. No title, no status, no type, no idea who raised it or when. Two
things block that, and they compound.

## Steps to reproduce

**1. Raise an incident on a dataset** (via GraphQL, since MCP has no write tool for this):

```graphql
mutation {
  raiseIncident(input: {
    type: DATA_SCHEMA
    title: "Stale runbook: Weekly order revenue pack"
    description: "A saved runbook references a column that no longer exists."
    resourceUrn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,db.analytics.order_details,PROD)"
    priority: MEDIUM
  })
}
```

**2. Read the dataset over MCP.** `get_entities` reports the incident exists, but names it
with a placeholder:

```json
"health": [
  { "type": "INCIDENTS", "status": "FAIL", "message": "1 active incident",
    "causes": ["ACTIVE_INCIDENTS"] }
]
```

`causes` is the literal string `"ACTIVE_INCIDENTS"`, not a URN. Compare the ASSERTIONS
branch of the very same field on another dataset, which *does* return real URNs:

```json
"health": [
  { "type": "ASSERTIONS", "status": "FAIL", "message": "1 of 1 assertions are failing",
    "causes": ["urn:li:assertion:payment-health-freshness"] }
]
```

So the same field is a URN list for assertions and a magic constant for incidents.

**3. Try to read the incident directly.** Even knowing the URN out of band:

```text
get_entities(urns=["urn:li:incident:65f09849-b7ea-43ec-bcf0-3686c970c15c"])
```

```json
[{"error": "Entity urn:li:incident:65f09849-b7ea-43ec-bcf0-3686c970c15c exists but no data
  could be retrieved. This can happen if the entity has no aspects ingested yet, or if
  there's a permissions issue.", "urn": "urn:li:incident:65f09849-b7ea-43ec-bcf0-3686c970c15c"}]
```

The entity exists and has aspects. `dataset(urn).incidents` over GraphQL returns its title,
state, stage and message quite happily. It just cannot be fetched through MCP.
Note this is reported with `isError: false`, so a caller that checks the error flag rather
than parsing the body will read it as an empty-but-successful result.

## Why it matters

Two concrete consequences:

1. **An agent can't triage.** "This table has an active incident" is not actionable
   without knowing whether the incident is a week-old freshness blip or an active data-loss
   event. The agent has to tell the user to go and look in the UI, which is the thing it
   was supposed to save them.

2. **An agent can't recognise its own writes.** This is what bit us. Our tool raises an
   incident when it detects that a saved runbook has gone stale. On the next scheduled
   sweep it re-reads the dataset, sees an active incident that wasn't there when the
   runbook was recorded, then reports it as fresh drift. It flags itself, every night,
   forever. Deduplicating means reading incident titles, so we had to drop out of MCP and
   query GraphQL directly:

   ```graphql
   query($urn: String!) {
     dataset(urn: $urn) { incidents(state: ACTIVE, start: 0, count: 50) { incidents { urn title } } }
   }
   ```

   Any agent that writes incidents will hit the same wall.

## Suggested fix

In rough order of value:

1. **Return real URNs in `causes` for the INCIDENTS health type**, matching the ASSERTIONS
   behaviour. This alone makes the incident identifiable.
2. **Make `urn:li:incident:*` readable through `get_entities`**, returning at minimum
   `title`, `description`, `status {state, stage, message}`, `type` and `created`.
3. Consider inlining a compact incident list on the dataset (title + state + urn) the way
   `health` already summarises, so the common case costs no extra round trip.

Item 1 is a small change and would unblock the dedup case on its own.

## Context

Found while building [instaboard](https://github.com/mcrowley19/Instaboard), a DataHub
onboarding and knowledge-handoff agent, for the DataHub Agent Hackathon. It detects when a
captured runbook has drifted from the catalog and writes the finding back as a native
Incident so it surfaces in the workflows a data team already watches.
