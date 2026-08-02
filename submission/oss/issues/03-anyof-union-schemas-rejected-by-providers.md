# Tool schemas use multi-type `anyOf` unions that OpenAI-compatible providers reject with a 422

**Repo:** `acryldata/mcp-server-datahub`
**Version:** `mcp-server-datahub` 0.6.0 (via `uvx mcp-server-datahub@latest`)

---

## Summary

Two tools declare parameters as unions of *different* JSON types. Several
OpenAI-compatible inference endpoints reject the whole tool list when they see one, so the
DataHub tool set cannot be handed to those providers without rewriting the schemas
client-side first.

## Steps to reproduce

1. List the server's tools and pass the schemas through unmodified as OpenAI-style
   function definitions.
2. Send a request to an OpenAI-compatible endpoint (reproduced via OpenRouter against
   `openai/gpt-oss-20b`):

   ```json
   {"error":{"message":"Provider returned error","code":422,"metadata":{
     "raw":"{\"error\":{\"code\":\"invalid_request_error\",
             \"message\":\"auto tool schemas do not support multi-type anyOf/oneOf unions\",
             \"param\":\"tools\",\"type\":\"invalid_request_error\"}}"}}}
   ```

   Every request fails. The whole conversation, rather than a single tool call, because
   validation rejects the tool list before anything runs.

## The offending schemas

16 of the 20 tools contain some `anyOf`. Most are the harmless nullable idiom
(`anyOf: [{"type": "string"}, {"type": "null"}]`) that Pydantic emits for `str | None`, and
most providers tolerate it. Two are genuine multi-type unions:

| Tool | Parameter | Schema |
| --- | --- | --- |
| `get_entities` | `urns` | `anyOf: [{"type": "array"}, {"type": "string"}]` |
| `add_structured_properties` | `property_values.additionalProperties.items` | `anyOf: [{"type": "string"}, {"type": "number"}, {"type": "integer"}]` |

A third is redundant rather than wrong, and worth cleaning up while you're in there.
`add_owners.ownership_type` is an `anyOf` of an enum-of-strings and a plain string, so the
enum branch constrains nothing:

```json
"ownership_type": {"anyOf": [
  {"type": "string", "enum": ["__system__technical_owner", "__system__business_owner", "__system__data_steward"]},
  {"type": "string"}
]}
```

## Suggested fix

- **`get_entities.urns`**: accept `{"type": "array", "items": {"type": "string"}}` only.
  Single-URN callers pass a one-element array; that is what every other tool
  (`add_tags.entity_urns`, `remove_owners.owner_urns`, …) already requires, so this also
  makes the surface consistent.
- **`add_structured_properties.property_values`**: `{"type": "number"}` already covers
  integers in JSON Schema, so dropping the `integer` branch leaves `["string", "number"]`,
  which can be expressed as `{"type": ["string", "number"]}`. Providers that reject
  `anyOf` unions generally accept the array-type form.
- **Nullable parameters**: emitting `{"type": ["string", "null"]}` instead of
  `anyOf: [{"type": "string"}, {"type": "null"}]` is equivalent and more widely accepted.
  In Pydantic that is a `json_schema_extra` / custom `GenerateJsonSchema` tweak rather than
  a signature change.
- **`add_owners.ownership_type`**: collapse to a single `{"type": "string"}` with the
  built-ins listed in the description (the docstring already explains custom types are
  looked up by name), or keep the enum and drop the open branch.

Happy to send a PR for the `get_entities.urns` narrowing, which is the one that actually
blocks providers, if that direction is acceptable.

## Why it matters

It rules out a whole class of models instead of degrading gracefully. We hit it running a
benchmark on a free-tier model, which is what people reach for while evaluating an agent
before committing spend. The failure is opaque too: a 422 on every request, carrying a
message that names neither DataHub nor the offending tool.

## Context

Found while building [instaboard](https://github.com/mcrowley19/Instaboard), a DataHub
onboarding and knowledge-handoff agent, for the DataHub Agent Hackathon. Its benchmark
hands the live MCP tool list straight to whichever provider the user configured, so it
sees whatever the schemas do.
