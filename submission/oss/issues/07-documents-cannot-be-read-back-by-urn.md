# A document written with `save_document` cannot be read back by its URN

**Repo:** `acryldata/mcp-server-datahub`
**Version:** mcp-server-datahub 0.6.0 (20 tools), GMS v1.5.0.6 (OSS quickstart)

---

## Summary

`save_document` returns the URN of the document it created. Nothing in the tool
surface will then give you that document's content back.

- `get_entities` on a document URN returns `[{"urn": "..."}]` — the URN it was
  given, and no other field. Not the title, not the body, not the related assets.
- `search_documents` returns metadata only: title, subType, tags, timestamps. No
  content.
- `grep_documents` returns excerpts around pattern matches, which is the closest
  thing to a read, but it is a search primitive: you have to already know what you
  are looking for, and a permissive pattern returns the same excerpt repeated once
  per match position (below).

So an agent can write knowledge into the catalog and cannot read its own writes.
That matters for any workflow where a document is the durable artifact rather than
the output — re-validating a saved runbook, checking whether a write succeeded and
landed the content intended, or updating a document without clobbering what is
already in it. Round-tripping through DataHub is the point of `save_document`, and
the round trip is missing its return leg.

This is the same shape as
[mcp-server-datahub#172](https://github.com/acryldata/mcp-server-datahub/issues/172),
where `get_entities` on an incident URN also fails to return the entity. Two
entity types now behave this way, which suggests the underlying issue is
`get_entities`' aspect selection rather than anything specific to documents.

## Steps to reproduce

**1. Write a document.**

```jsonc
// save_document
{
  "document_type": "Note",
  "title": "read-after-write probe",
  "content": "# probe\n\nTransient note created to observe the save_document response contract.",
  "topics": ["probe"],
  "related_assets": ["urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)"]
}
```

Response, after ~2.8s:

```json
{
  "success": true,
  "urn": "urn:li:document:shared-a33dab22-d94d-49d3-84ac-4a6cc9fb73c2",
  "message": "Successfully created document: read-after-write probe",
  "author": "__datahub_system"
}
```

**2. Read it back by URN.**

```jsonc
// get_entities
{ "urns": ["urn:li:document:shared-a33dab22-d94d-49d3-84ac-4a6cc9fb73c2"] }
```

```json
[{"urn":"urn:li:document:shared-a33dab22-d94d-49d3-84ac-4a6cc9fb73c2"}]
```

That is the whole response. Retried at t+0s, t+2s, t+5s and t+10s — identical
every time, so this is not an indexing lag. The document is genuinely there: the
DataHub UI renders it, and `search_documents` finds it.

**3. Try search instead.**

```jsonc
// search_documents
{ "query": "read-after-write probe" }
```

Returns `total: 1` with `entity.info.title`, `subType`, `platform`, `tags`,
`created`, `lastModified` — and no field carrying the content.

**4. Try grep, the only tool that touches the body.**

```jsonc
// grep_documents
{ "urns": ["urn:li:document:shared-..."], "pattern": ".*" }
```

```json
{"results":[{"urn":"urn:li:document:shared-...","title":"read-after-write probe",
 "matches":[
   {"excerpt":"# probe\n\nTransient note created to observe the save_document response contract.","position":0},
   {"excerpt":"# probe\n\nTransient note created to observe the save_document response contract.","position":7},
   {"excerpt":"# probe\n\nTransient note created to observe the save_document response contract.","position":8},
   {"excerpt":"# probe\n\nTransient note created to observe the save_document response contract.","position":9},
   {"excerpt":"# probe\n\nTransient note created to observe the save_document response contract.","position":79}],
 "total_matches":5}],"total_matches":5,"documents_with_matches":1}
```

Two problems in one response. The same excerpt is returned five times, once per
match position, so reconstructing a document means de-duplicating overlapping
excerpts and hoping the windows tile. And `.*` matching at positions 0, 7, 8, 9
and 79 of an 80-character document is a zero-width-match artifact rather than a
useful result — a caller trying to dump a document this way gets a response whose
size scales with the document, not with its content.

## Expected

Either of these would close it:

1. `get_entities` on a document URN returns the document's aspects, the way it
   does for a dataset — at minimum `title`, `content` and `relatedAssets`.
2. A `get_document(urn)` tool, alongside `search_documents` and `grep_documents`,
   that returns the stored content.

The first is the smaller change and would also fix
[#172](https://github.com/acryldata/mcp-server-datahub/issues/172) for incidents.

Separately, `grep_documents` should collapse overlapping excerpts and should not
report zero-width matches as matches.

## Impact

We hit this building a tool that writes runbooks into DataHub with
`save_document` and re-validates them against the catalog later. We could not
re-read our own documents, so the runbook body has to be kept in local storage
and DataHub holds the shared copy — which is the opposite of what we wanted, and
means the two can diverge with nothing to detect it.

The workaround we shipped is to treat `save_document`'s returned URN as a receipt
and never read the document back — every write is fire-and-forget, and
verification happens against the local copy. Anyone building a document-centric
integration will hit the same wall.

## Environment

```
mcp-server-datahub 0.6.0  (uvx, TOOLS_IS_MUTATION_ENABLED=true)
DataHub GMS v1.5.0.6      (datahub docker quickstart)
macOS 15.6 / arm64, Node 22
```
