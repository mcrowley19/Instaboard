# Benchmark results

`scorecard.md` and `latest.json` are generated — run the benchmark to produce them:

```bash
DEMO_MODE=true npm run eval
```

Requires `LLM_PROVIDER` and `LLM_API_KEY` in `.env.local`. Takes a few minutes;
results land here.

- **`scorecard.md`** — headline numbers, per-category breakdown, and every failed
  check with the reason it failed.
- **`latest.json`** — the full record: each case's raw answer, the tools the agent
  called, per-check pass/fail, and latency. Use this to audit any single check by
  hand rather than taking the score on faith.

Both are committed after a run so a reader can see the results without an API key.

## Reading a result honestly

Scores depend on the model. A small model will miss URN citations and confabulate
on the `hallucination` cases regardless of catalog access, which compresses the gap
between arms; a frontier model widens it. The scorecard records which model produced
it in its header — compare like with like, and re-run both arms together on the same
model, which is what `npm run eval` does by default.
