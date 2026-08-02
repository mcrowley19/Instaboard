# Live DataHub verification — 2026-08-02

Every claim below was executed against a **real DataHub** (docker quickstart,
GMS on `:8080`) through the official `mcp-server-datahub` over stdio — no demo
fixture involved. The raw evidence is committed at
[`examples/live/receipts.json`](../examples/live/receipts.json) and is
regenerable by anyone:

```bash
npm run datahub:up && npm run seed   # live stack + Northbeam catalog
npm run receipts:live                # re-captures every receipt below
```

## What was verified (7/7 steps passed)

| Step | Evidence |
| --- | --- |
| MCP handshake | 18 tools listed by the live server (`search`, `get_lineage`, `save_document`, …) |
| `search` round-trip | live results for "revenue" with real URNs |
| `get_entities` | `fct_revenue` with owners, schema, domain from GMS |
| Health signal | `payment_health_daily` reports `ASSERTIONS: FAIL` — caused by `urn:li:assertion:payment-health-freshness` |
| Decay detection | the sample runbook's step 1 flagged: **1 failing assertion (was 0 when recorded)** — the exact drift the demo shows, reproduced on live data |
| Write-back | `save_document` created `urn:li:document:shared-147cf125-30d0-43ad-b328-54e516cbc178`, linked to the affected datasets |
| Read-back | a follow-up `search` returns that same document URN — the write is in the catalog, not just claimed |

## Seen in the DataHub UI

- [The stale-runbook note rendered in DataHub](screenshots/stale-runbook-note-in-datahub.jpg)
  at the exact URN in the receipt (`urn:li:document:shared-147cf125-…`), linked
  to the affected datasets.
- [`payment_health_daily`'s Quality tab](screenshots/payment-health-failing-assertion.jpg)
  showing the failing assertion the decay engine keyed on.
- [Animated capture of the validation flow](media/validate-live.gif) running
  against this live stack.

## Why this matters

The demo fixture and the live path share one code path (`lib/decay.ts`,
`lib/mcp.ts`); this run proves the shapes match reality. Two robustness fixes
came out of the live run and are in the same commit as these receipts: the
decay engine now reads live DataHub's inlined `health` summary (in addition to
the fixture's per-assertion lists), and owner comparison normalizes usernames
against display names so live catalogs don't produce false "owner changed"
findings.
