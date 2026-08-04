# The upstream fix

`mcp-server-datahub-newer-gms-on-oss.patch` is one commit against
[`acryldata/mcp-server-datahub`](https://github.com/acryldata/mcp-server-datahub),
with a regression test.

Apply it with `git am < mcp-server-datahub-newer-gms-on-oss.patch`.

## What it fixes

The bug we filed as
[documents cannot be read back by URN](../issues/07-documents-cannot-be-read-back-by-urn.md):
`save_document` returns a URN, and nothing in the tool surface will give you
that document's content back. `get_entities` on the URN returns `{"urn": "..."}`
and nothing else.

That write-up said what happened, and left the reason open. The reason turns out
to be one line.

## Why it happens

`entity_details.gql`, the query behind `get_entities`, does select the document's
title, contents and related assets. Every one of those lines carries a
`#[NEWER_GMS]` marker, and `execute_graphql` strips marked lines unless the
server is DataHub **Cloud**:

```python
# First attempt: try with newer GMS fields if it's detected as cloud
# (Cloud instances typically run newer GMS versions)
if is_cloud:
    query = _enable_newer_gms_fields(query)
```

"Cloud typically runs a newer GMS" is true. The inference drawn from it, that a
self-hosted server therefore does not, breaks down. A self-hosted GMS on 1.5+
serves every one of these fields and was having them stripped on the way out, so
the document was never unreachable and `get_entities` simply never asked for
it.

## The evidence

Against the OSS quickstart the issue was filed on, GMS v1.5.0.6, sending the
whole of `entity_details.gql` two ways:

| `#[NEWER_GMS]` fields | GraphQL result | Fields returned |
| --- | --- | --- |
| stripped (what OSS gets today) | no errors | `urn`, and nothing else |
| left in | no errors | `urn`, `info`, `subType`, `platform`, `ownership`, `tags`, `domain`, `glossaryTerms`, plus the title and **5,102 characters** of content |

No validation errors either way, and all 76 `#[NEWER_GMS]` fields in that query
resolve on 1.5.0.6. The server was willing the whole time.

## The change

Key the decision to the server version. Cloud stays as it was, and
self-hosted qualifies once it is at least 1.5.0, read from `server_config`, which
the codebase already consults for tool-level version gating.

Guessing wrong stays cheap, because the existing recovery path is untouched:
`execute_graphql` already retries once with the fields disabled on a validation
error and caches the answer per graph. An over-optimistic guess costs one round
trip on the first query and nothing afterwards.

Five tests cover the new decision, including the OSS-1.5 case that was the bug,
an older OSS server, Cloud, the `DISABLE_NEWER_GMS_FIELD_DETECTION` opt-out, and
a server whose `/config` cannot be read. The repo's own
`test_combined_tags_scenario` already asserted *"Scenario 2: OSS instance (CLOUD
fields hidden, NEWER_GMS shown)"*, so this restores the behaviour the tests said
was there.

Upstream suite after the change: 506 passed, `ruff` and `mypy` clean.

## What it changes here

instaboard kept runbook bodies in local storage because DataHub could not be
asked for them back. With this fix the read leg exists, so the catalog can hold
the copy that counts. See
[`lib/document-readback.ts`](../../../lib/document-readback.ts) and the
round-trip proof in `npm run prove`.
