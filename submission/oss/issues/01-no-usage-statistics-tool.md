# No tool exposes dataset usage statistics, and `get_entities` doesn't inline them

**Repo:** `acryldata/mcp-server-datahub`
**Version:** `mcp-server-datahub` 0.6.0 (via `uvx mcp-server-datahub@latest`), GMS v1.5.0.6 (OSS quickstart)

---

## Summary

There is no MCP tool that returns dataset usage statistics, and `get_entities` does not
inline them either. An agent connected to DataHub over MCP cannot find out how often a
table is queried, or by how many distinct users, at all.

## Steps to reproduce

1. Start an OSS quickstart and ingest a dataset that has a `datasetUsageStatistics`
   aspect.
2. List the server's tools. All 20:

   ```text
   search, get_lineage, get_dataset_queries, get_entities, list_schema_fields,
   get_lineage_paths_between, search_documents, grep_documents, add_tags, remove_tags,
   add_terms, remove_terms, add_owners, remove_owners, set_domains, remove_domains,
   update_description, add_structured_properties, remove_structured_properties,
   save_document
   ```

   None of them reads usage.

3. Call `get_entities` on a dataset that has usage data and grep the response:

   ```text
   "usage        -> ABSENT
   "statsSummary" -> ABSENT
   "queryCount"   -> ABSENT
   "lastProfile"  -> ABSENT
   ```

   (`health`, `deprecation`, `ownership`, `glossaryTerms`, `structuredProperties`,
   `schemaMetadata` and `domain` all come back in the same response. Usage is the one
   thing missing.)

4. `get_dataset_queries` is the closest thing, but it returns the recorded query *texts*,
   not aggregate counts, and returns `{"start": 0, "total": 0, "count": 10}` for datasets
   whose usage aspect is populated but whose query bodies were never captured.

## Why it matters

Usage is the single most reliable signal for the question agents are asked constantly:
*which of these lookalike tables is the real one?*

A realistic catalog holds the same logical table many times over: a Postgres source, an S3
export, a Snowflake copy, a dbt model, a Looker view, a BI extract. DataHub's own
`showcase-ecommerce` datapack has six datasets called some form of `order_details`, plus an
`ORDER_DETAILS_REPLICA` whose 55-column schema matches byte for byte. Names, row counts and
descriptions cannot separate those. 30-day query volume can.

With no usage tool, an MCP agent falls back on ranking by how plausible a name sounds,
which is the failure DataHub exists to prevent. The documented alternative is to shell out:

```bash
datahub get --urn "urn:li:dataset:(urn:li:dataPlatform:snowflake,db.schema.table,PROD)" \
  -a datasetUsageStatistics
```

which requires the CLI installed and authenticated alongside the MCP server, and puts the
one metric an agent most needs outside the protocol it is talking.

## Suggested fix

Either would resolve it:

- **A `get_usage_stats(urn, window)` tool** returning query count, distinct user count and
  top users for a window, mirroring what the "Stats" tab shows in the UI.
- **Inline a usage summary on `get_entities`**, alongside the existing `health` block, e.g.
  `"usage": {"queryCountLast30Days": 812, "uniqueUserCountLast30Days": 31}`. This is the
  cheaper change and fits how `health` is already surfaced.

Happy to open a PR for either if you can say which shape you'd prefer.

## Context

Found while building [instaboard](https://github.com/mcrowley19/Instaboard), a DataHub
onboarding and knowledge-handoff agent, for the DataHub Agent Hackathon. The workaround in
that codebase is to rank on certification markers, ownership coverage and the
platform-assigned `📈 Most Queried` tag instead, and to say "the catalog has no usage data"
rather than guess. Those signals only exist in some deployments, and none of them is the
number the user asked for.
