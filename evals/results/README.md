# Benchmark results

`scorecard.md` and `latest.json` are generated. Run the benchmark to produce
them:

```bash
DEMO_MODE=true npm run eval
```

That needs `LLM_PROVIDER` and `LLM_API_KEY` in `.env.local`. It takes a few
minutes, and the results land here.

- **`scorecard.md`**: headline numbers, a per-category breakdown, and every
  failed check with the reason it failed.
- **`latest.json`**: the full record, holding each case's raw answer, the tools
  the agent called, per-check pass/fail, and latency. Use this one to audit any
  single check by hand.

Both are committed after a run so a reader can see the results without an API
key.

## Reading a result honestly

Scores depend on the model. A small model will miss URN citations and confabulate
on the `hallucination` cases whatever catalog access it has, which compresses the
gap between arms, and a frontier model widens it. The scorecard records which
model produced it in the header, so compare like with like, and re-run both arms
together on the same model, which is what `npm run eval` does by default.
