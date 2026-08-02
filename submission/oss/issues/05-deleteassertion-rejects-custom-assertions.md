# `deleteAssertion` rejects CUSTOM assertions, so anything created by `upsertCustomAssertion` cannot be removed through the API that created it

**Repo:** `datahub-project/datahub`
**Version:** GMS v1.5.0.6 (OSS quickstart), GraphQL API

---

## Summary

`upsertCustomAssertion` creates an assertion with `info.type = CUSTOM`. `deleteAssertion`
then refuses to delete it, with `Unsupported Assertion Type CUSTOM provided`. The two
mutations sit next to each other in the same API and disagree about whether CUSTOM is a
real assertion type.

The practical effect is that any integration using custom assertions — which is the
documented way for an external tool to report its own checks into DataHub — can create
state it has no supported way to clean up. The only route out is
`datahub delete --urn ... --hard` over the CLI, which is a different tool, needs different
credentials, and is not something a service integration generally has.

## Steps to reproduce

**1. Create a custom assertion:**

```graphql
mutation {
  upsertCustomAssertion(
    urn: "urn:li:assertion:my-tool-1"
    input: {
      entityUrn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,db.schema.table,PROD)"
      type: "Runbook validity"
      description: "Every catalog claim made by the saved runbook still holds."
      platform: { name: "my-tool" }
    }
  ) { urn }
}
```

Returns `{"data": {"upsertCustomAssertion": {"urn": "urn:li:assertion:my-tool-1"}}}`.

**2. Confirm it exists and is CUSTOM:**

```graphql
query { assertion(urn: "urn:li:assertion:my-tool-1") { urn info { type description } } }
```

```json
{ "data": { "assertion": { "urn": "urn:li:assertion:my-tool-1",
  "info": { "type": "CUSTOM", "description": "Every catalog claim made by the saved runbook still holds." } } } }
```

**3. Try to delete it through the same API:**

```graphql
mutation { deleteAssertion(urn: "urn:li:assertion:my-tool-1") }
```

```json
{ "errors": [{ "message": "java.lang.RuntimeException: Unsupported Assertion Type CUSTOM provided.
  Root cause: Unsupported Assertion Type CUSTOM provided" }] }
```

**4. The CLI will do it:**

```bash
DATAHUB_GMS_URL=http://localhost:8080 datahub delete --urn "urn:li:assertion:my-tool-1" --hard -f
# Hard deleted 1 entities (impacts 3 versioned rows and 1 timeseries aspect rows) in 0.06 seconds.
```

So the entity is deletable; `deleteAssertion` is simply gating on a type list that omits
the type its sibling mutation produces.

## Expected

`deleteAssertion` accepts any assertion URN that `assertion(urn:)` resolves, including
CUSTOM. If some assertion types genuinely cannot be deleted through this path, the error
should say which ones and why, rather than reporting the type as "unsupported" when it was
created by the API two calls earlier.

## Why it matters

Custom assertions are how an external tool reports its own checks into DataHub's health
model — which is exactly what the docs recommend them for. An integration that can create
but not retract them accumulates permanent state on customer datasets. In our case each
assertion is scoped to a (runbook, dataset) pair, so a deleted runbook leaves behind an
assertion that will never be reported against again and cannot be removed by the service
that made it.

## Context

Found while building [instaboard](https://github.com/mcrowley19/Instaboard), which reports
a custom assertion per saved runbook that fails while the runbook is stale and passes once
it validates clean again. Creating and reporting results both work well; the gap is only
in removal.
