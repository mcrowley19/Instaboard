# `showcase-ecommerce` datapack silently drops all usage and quality data on OSS DataHub

**Repo:** `datahub-project/datahub`
**Versions:** `acryl-datahub` 1.6.0.17 CLI, DataHub OSS quickstart GMS v1.5.0.6

---

## Summary

Loading the `showcase-ecommerce` datapack into an OSS quickstart drops 248 of its 3,809
MCPs, because those aspects only exist in DataHub Cloud. Everything usage-related and
everything quality-related is in the dropped set. The load reports
`Data pack 'showcase-ecommerce' loaded successfully.` and exits 0, and the registry lists
the pack as `verified`, so there is nothing to tell an OSS user that the demo they just
loaded has no usage or assertion data in it.

## Steps to reproduce

```bash
datahub docker quickstart          # OSS, GMS v1.5.0.6
datahub datapack load showcase-ecommerce
```

Mid-load, on file 2 of 3:

```text
Filtered 248 incompatible MCPs (3561/3809 remaining):
  dataset/entityInferenceMetadata: 67 skipped
  dataset/lineageFeatures: 67 skipped
  dataset/usageFeatures: 27 skipped
  dataset/storageFeatures: 25 skipped
  dataJob/lineageFeatures: 23 skipped
  chart/lineageFeatures: 12 skipped
  dataset/assertionsSummary: 9 skipped
  domain/status: 6 skipped
  corpuser/corpUserUsageFeatures: 4 skipped
  dashboard/lineageFeatures: 3 skipped
  dataset/documentation: 1 skipped
  dataset/schemaProposals: 1 skipped
  dataset/proposals: 1 skipped
  dashboard/usageFeatures: 1 skipped
  dashboard/proposals: 1 skipped
```

and at the end:

```text
Data pack 'showcase-ecommerce' loaded successfully.
```

Then confirm what went missing. There is no usage anywhere in the catalog:

```bash
datahub get --urn "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)" \
  -a datasetUsageStatistics     # empty
```

The 67 datasets, 873 schema fields, lineage graph, glossary, domains, data products, tags
and structured properties all land correctly. It is specifically the usage and quality
surface that silently doesn't.

## Why it matters

The pack's own description sells exactly the features that don't survive the load:

> Rich e-commerce demo with 1049 entities across Snowflake, Looker, PowerBI, Tableau,
> lineage, governance

An OSS user loading this pack to demo usage-based ranking, the Stats tab, or assertion
health gets an empty result with no explanation, and reasonably concludes their install is
broken rather than that the data was never ingested. Two of us hit exactly this while
building agents against the pack for the DataHub Agent Hackathon.

It also silently changes what an agent built on the pack can do. `usageFeatures` is how
"which of these six `order_details` copies is the real one?" gets answered; without it the
agent has to fall back on certification tags and ownership coverage.

## Suggested fixes

Any one of these would do; the first is the cheapest:

1. **Say so at the end, not only mid-log.** Summarise the drop in the final message rather
   than only in a table 40 lines up:
   `loaded successfully. 248 aspects skipped (DataHub Cloud only): usage statistics and
   assertion summaries are not present in this catalog.`
2. **Flag it in the registry.** `datahub datapack list` shows a `Trust` column; a
   `Requires` or `Best on` column, or a note in the description, would let someone choose
   an OSS-complete pack before spending the download.
3. **Ship OSS equivalents where they exist.** `datasetUsageStatistics` is an OSS aspect, so
   the pack could carry it alongside the Cloud `usageFeatures` and give both deployments
   usable usage data.
4. **Exit non-zero, or at least warn**, when a "verified" pack loses whole aspect
   categories. Right now a scripted load can't tell a clean load from a half one.

## Context

Found while building [instaboard](https://github.com/mcrowley19/Instaboard), a DataHub
onboarding and knowledge-handoff agent, for the DataHub Agent Hackathon. We load this
datapack on purpose, to benchmark the agent against a catalog we did not author, so the gap
showed up as missing benchmark categories rather than as a broken install.
