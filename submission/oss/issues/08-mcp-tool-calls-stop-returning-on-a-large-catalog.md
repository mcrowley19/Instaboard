# `get_entities` stops returning entirely on a larger catalog, while the same read over GraphQL takes 4.5s

**Repo:** `acryldata/mcp-server-datahub`
**Version:** mcp-server-datahub@latest via `uvx`, GMS v1.5.0.6 (OSS quickstart), macOS 15.6 / arm64, Node 22

---

## Summary

On a catalog of ~10,000 datasets, `get_entities` calls stopped completing. Not
slowly — at all. The client waited **295+ seconds** with no response, while:

- the MCP server process sat at **0% CPU**,
- the calling process sat at **0% CPU**,
- every DataHub container was healthy and idle (GMS 2.3% CPU, OpenSearch 4.2%),
- GMS answered the **equivalent GraphQL query directly in 26ms**, and
- the same `get_entities` read performed over GraphQL instead returned correct
  data in **4.5s**.

So this is not GMS being slow and not the machine being loaded. Something in the
client stops waiting for a reply that is never going to arrive, and there is no
timeout, so the caller waits forever.

## How we hit it

We run an unattended sweep that reads a handful of entities by URN and diffs
them against snapshots. It is deliberately small: 5 runbooks, ~15 entity reads
per pass, no search. To measure how it scales we grew a local DataHub in stages
and swept at each size:

| Catalog size | Sweep over MCP | Result |
| --- | --- | --- |
| 91 datasets | ~103s | fine |
| 1,091 | ~107s | fine |
| 5,091 | ~85s | fine |
| **10,091** | **never completed** | hung >30 min |

The first three are the same workload — the sweep reads the entities the
runbooks name, not the catalog — so the flat line is expected. The fourth is
the problem.

After killing and restarting the client, calls kept failing the same way. With a
90s client-side timeout imposed, calls timed out repeatedly rather than
succeeding, and the subprocess was visibly being torn down and respawned (a
fresh PID every ~90s).

## What isolates it to the client

Same machine, same moment, same catalog, same entity:

```
mcp-server-datahub  get_entities   → no response after 295s   (0% CPU both ends)
GraphQL             entities(urns) → 4.5s, correct data
GraphQL (curl)      dataset(urn)   → 26ms
```

We had built a small GraphQL shim implementing the four tools we use
(`get_entities`, `get_dataset_health`, `save_document`, `add_tags`) for an
unrelated reason — serverless hosts cannot spawn a stdio subprocess. Swapping the
transport made the workload complete. Nothing else changed.

## What we cannot tell you

We could not isolate **catalog size** from **accumulated load**. By the time the
hang appeared, that DataHub had absorbed roughly 40,000 document writes and
deletes over an afternoon, and its own read latency had degraded (a per-entity
read that had taken ~1s was taking 6–9s even over GraphQL). So "10k datasets" may
be a red herring and the real trigger may be a server under sustained write
pressure, or a connection that has been open a long time, or a pool that is
exhausted rather than a request that is slow.

What we are confident of is the shape: **the server had an answer available in
milliseconds, and the MCP client never produced one, indefinitely.**

## Why the indefinite part matters most

Whatever the trigger, a tool call with no deadline turns a recoverable failure
into a silent one. Our sweep is a cron job — the whole point is that nobody is
watching it — so its failure mode was to hang until a human noticed, rather than
to fail and be retried or alerted on. We have since imposed a client-side
timeout ourselves, but a default deadline in the client would have made this a
logged error rather than a hung process, and would have cost us an afternoon
less.

## Suggested

1. A default request timeout on MCP tool calls, configurable, so a lost reply
   surfaces as an error rather than an indefinite wait.
2. If the underlying cause is a connection or pool that can be left in a state
   where replies stop arriving, detecting and re-establishing it.

Happy to run any diagnostic that would help narrow it — we can rebuild the
10k-dataset catalog on demand.
