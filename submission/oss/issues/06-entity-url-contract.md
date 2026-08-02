# No supported way for a browser integration to know which entity a DataHub page is showing

**Repo:** `datahub-project/datahub`
**Version:** GMS + frontend v1.5.0.6 (OSS quickstart), reproduced on the `showcase-ecommerce` datapack

---

## Summary

DataHub encodes the entity URN in the UI URL, so a browser extension or userscript
can in principle tell which entity the user is looking at without an API call.
In practice it cannot do so reliably, because the mapping from entity type to URL
path segment is neither documented nor derivable, and the obvious implementation
is wrong for seven of the thirty entity routes.

There is no supported alternative either: nothing on the rendered page states the
current entity, so URL parsing is the only option available.

## The specific problem

Most routes match their entity type. These do not:

| Entity type | Actual URL segment |
| --- | --- |
| `dataFlow` | `/pipelines/` |
| `dataJob` | `/tasks/` |
| `mlFeature` | `/features/` |
| `mlFeatureTable` | `/featureTables/` |
| `mlPrimaryKey` | `/mlPrimaryKeys/` |
| `mlModel` | `/mlModels/` |
| `corpUser` | `/user/` |
| `corpGroup` | `/group/` |
| `dataPlatform` | `/platform/` |
| `businessAttribute` | `/business-attribute/` |
| `dataContract` | `/dataContracts/` |

An integration written against the entity-type names silently detects nothing on
pipeline and task pages. The failure is invisible: "no entity found" and "not a
DataHub page" are the same result, so nothing alerts you that the detection is
broken for a whole class of entities. We shipped exactly this bug and did not
notice for weeks.

## Steps to reproduce

**1. Confirm the routes are not the type names.** On a running DataHub, open
`/search?query=<something matching a spark task>` and read the anchor hrefs:

```js
[...document.querySelectorAll('a[href]')]
  .map(a => a.getAttribute('href'))
  .filter(h => h.includes('urn:li:'))
```

Against the `showcase-ecommerce` datapack this returns, among others:

```
/tasks/urn:li:dataJob:(urn:li:dataFlow:(spark,b2fd91.export_table_orders_to_s3,b2fd91.default),b2fd91.export_table_orders_to_s3)/
/pipelines/urn:li:dataFlow:(spark,b2fd91.export_table_orders_to_s3,b2fd91.default)/
```

`urn:li:dataJob:` is served at `/tasks/`, and `urn:li:dataFlow:` at `/pipelines/`.

**2. Confirm nothing on the page states the entity.** On any entity page:

```js
document.querySelector('meta[name*="urn" i], meta[name*="entity" i]')  // → null
window.__DATAHUB_ENTITY__                                              // → undefined
```

**3. Confirm the mapping is not exported anywhere reachable.** The registry that
knows it is internal to `datahub-web-react`:

```js
// EntityRegistry
pathNameToEntityType = new Map();
register(entity) { this.pathNameToEntityType.set(entity.getPathName(), entity.type); }
```

Each entity class hard-codes its own `getPathName()`. The map exists, is correct,
and is unreachable from outside the bundle. Today the only way to obtain it is to
grep the built JavaScript:

```bash
curl -s http://localhost:9002/assets/index-*.js \
  | grep -oE 'getPathName\(\)\{return"([^"]+)"' | sed 's/.*"\(.*\)"/\1/' | sort -u
```

That is not a contract anyone should be depending on, and it breaks on any
refactor of the registry.

## A second, smaller trap

The URN is not a simple path segment. It can contain slashes, parentheses,
commas and percent-encoding, and DataHub appends a tab name after it:

```
/dataset/urn:li:dataset:(urn:li:dataPlatform:s3,b2fd91.demo-data-bucket%2Forder_entry%2Forders,PROD)/Columns?schemaFilter=order_id
```

Splitting on `/` truncates the URN. `decodeURIComponent` throws outright on a
malformed escape, taking the caller with it unless it is guarded. Neither is
hard to handle once you know, and both are easy to get wrong first.

## What would fix it

Either of these, in preference order:

1. **Expose the entity on the page.** A `<meta name="datahub:entity-urn" content="urn:li:...">`
   and `<meta name="datahub:entity-type" content="dataJob">` on entity pages, or a
   `window.__DATAHUB_ENTITY__ = { urn, type }`. A few lines in the entity page
   component. Integrations then never parse a URL, and DataHub is free to change
   routes without breaking anyone downstream.
2. **Publish the mapping.** Document the entity-type ↔ path-name table, or export
   `pathNameToEntityType` from the entity registry, so integrators read it rather
   than rediscovering it from a minified bundle.

(1) is strictly better because it decouples integrations from routing entirely.
(2) is worth doing regardless, since server-side integrations that only have a URL
string still need it.

## A reference implementation, if useful

A dependency-free module with the full route table, plus 16 test vectors captured
from a running DataHub by reading rendered hrefs rather than constructing URLs:

<https://github.com/mcrowley19/Instaboard/tree/main/submission/oss/entity-detection>

MIT, and happy to open it as a PR against `datahub-web-react` or the docs in
whatever form is useful — including as the reference for option (1) above.

## Context

Found while building [instaboard](https://github.com/mcrowley19/Instaboard), a
DataHub onboarding and knowledge-handoff agent whose Chrome side panel follows the
user around the DataHub UI and answers questions about the entity on screen. The
side panel needs exactly one thing from the page — which entity it is — and this
is the part that turned out to have no supported answer.
