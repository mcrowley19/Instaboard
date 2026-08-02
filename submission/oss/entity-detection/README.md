# Knowing which entity a DataHub page is showing

A reusable answer to a problem every browser-side DataHub integration hits, plus
the upstream ask that would make it unnecessary.

| File | What it is |
| --- | --- |
| [`datahub-entity-from-url.js`](datahub-entity-from-url.js) | dependency-free module: URL → `{urn, entityType, route}`. Works as a content script, an ES/CJS import, or a copy-paste |
| [`url-vectors.json`](url-vectors.json) | 16 test vectors captured from a running DataHub by reading hrefs out of the rendered UI, not by constructing them |
| [`../issues/06-entity-url-contract.md`](../issues/06-entity-url-contract.md) | the upstream issue |

The module is byte-identical to the one instaboard's Chrome side panel ships
(`extension/entity-from-url.js`) — a test fails the build if the two drift, because
publishing a copy that differs from what we run is worse than publishing nothing.

## The problem

DataHub puts the URN in the URL, which is generous: an extension can tell what
you are looking at without an API round trip. But the mapping from entity type to
URL segment is **not published and not derivable**. Eleven of the thirty-one routes
do not match their entity type name, and five are a different word entirely:

| Entity type | URL segment |
| --- | --- |
| `dataFlow` | `/pipelines/` |
| `dataJob` | `/tasks/` |
| `mlFeature` | `/features/` |
| `mlFeatureTable` | `/featureTables/` |
| `mlPrimaryKey` | `/mlPrimaryKeys/` |
| `mlModel` | `/mlModels/` |
| `corpUser` / `corpGroup` | `/user/` and `/group/` |
| `dataPlatform` | `/platform/` |
| `businessAttribute` | `/business-attribute/` |

So the obvious implementation is wrong, and wrong in the worst way. Every version
of our extension up to this one matched `/dataFlow/` and `/dataJob/` — routes
DataHub has never served — so the side panel silently failed to detect a page
whenever anyone opened a pipeline or a task, two of the entity types an onboarding
tool most wants to see. It failed by returning "no entity", which is
indistinguishable from "not a DataHub page", so nothing ever surfaced it. We found it by extracting `getPathName()`
from the frontend bundle's entity registry and diffing against what we had.

The URN is also not a simple path segment. It can contain slashes, parentheses,
commas and percent-encoding, and DataHub appends a tab name after it:

```
/dataset/urn:li:dataset:(urn:li:dataPlatform:s3,b2fd91.demo-data-bucket%2Forder_entry%2Forders,PROD)/Columns?schemaFilter=order_id
```

Splitting on `/` gives you a truncated URN. So does `decodeURIComponent` on a
malformed escape, which throws.

## Using it

```js
datahubEntityFromUrl("http://localhost:9002/tasks/urn:li:dataJob:(urn:li:dataFlow:(spark,nightly,PROD),load)/Lineage");
// → { urn: "urn:li:dataJob:(urn:li:dataFlow:(spark,nightly,PROD),load)", entityType: "dataJob", route: "tasks" }

datahubEntityFromUrl("http://localhost:9002/search?query=orders");
// → null
```

Returns `null` rather than throwing on anything it does not recognise, including
malformed percent-escapes and non-DataHub URLs.

## What we are actually asking for upstream

The module is a workaround, and it will rot the first time DataHub renames a
route. Two fixes, either of which makes it unnecessary:

1. **Publish the contract.** Document the entity-type ↔ path-name mapping, or
   export the existing `pathNameToEntityType` map from the entity registry so
   integrators read it instead of rediscovering it.
2. **Better: put the entity on the page.** A `<meta name="datahub:entity-urn">`
   tag, or `window.__DATAHUB_ENTITY__ = {urn, type}`, on entity pages. Then no
   integration parses URLs at all, and DataHub is free to change its routes
   whenever it likes without breaking anyone.

The second is a few lines in the entity page component and would make every
browser-side DataHub integration — ours and anyone else's — both simpler and
immune to route changes.

## How the table was built

```bash
# 1. entity registry path names, from a running DataHub's frontend bundle
curl -s http://localhost:9002/assets/index-*.js \
  | grep -oE 'getPathName\(\)\{return"([^"]+)"' | sed 's/.*"\(.*\)"/\1/' | sort -u

# 2. spot-check against real hrefs in the rendered UI
#    (open /search?query=order, read anchor hrefs matching /^\/([a-zA-Z-]+)\/(urn:li:)/)
```

Captured against DataHub 1.5.0.6 (OSS quickstart) with the `showcase-ecommerce`
datapack loaded, on 2026-08-02.
