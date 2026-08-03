# The held-out suite

The ablation is the strongest claim in this repo: the same agent loop, on the
same questions, scores far higher with the catalog than without it. The fair
objection is that we wrote the questions. A benchmark whose author knows the
system is a benchmark the system was fitted to, however honestly it was written.

This suite exists to take that objection away as far as it can be taken away.

## What is not ours

| | Written by |
| --- | --- |
| The catalog | DataHub — `showcase-ecommerce`, their published demo datapack |
| The questions | a different vendor's model, from `catalog-dump.json` and `author-prompt.md` and nothing else |
| The answer keys | the same model, in the same pass |
| The scorer | ours, unchanged — `evals/score.ts`, deterministic substring matching, no LLM judge |

The author model was shown one thing: a flat JSON read of the catalog off a live
GMS. It never saw instaboard's system prompt, its tool list, the skill, the
README, the scorer's source, or the two benchmarks we wrote ourselves. It was
not told that DataHub was involved, that there were arms, or what kind of system
would be answering. It was told to include questions it expected a good
assistant to get wrong.

## What that buys, and what it does not

**It buys:** nobody who knew what this tool is good at chose these questions.
That is the specific defect in a self-authored benchmark, and it is gone.

**It does not buy:** we wrote the instructions to the author, and instructions
shape a set. `author-prompt.md` is committed verbatim, unedited, so the shaping
is something you can read rather than something you have to take on trust. We
also chose the catalog — though DataHub authored it — and we chose to run on a
catalog rather than a warehouse, which is the domain the whole project is about.

**It is one model's set, once.** Twenty questions from one author is not a
confidence interval. The most useful thing anyone reading this can do is delete
`cases.json`, run `author.ts` with their own model, and see whether the gap
survives. If it does not, we would rather know.

## The filter, and why it is not a thumb on the scale

Generated cases can be unusable for reasons that have nothing to do with
difficulty:

- an answer key naming a table that is not in the catalog measures nothing, and
- a `mustNotInclude` needle that *is* in the catalog fails correct answers.

`author.ts` checks both mechanically, before any arm runs, and writes every
rejection into `cases.json` with its reason. The filter cannot see how hard a
case is, and no case has ever been dropped for being one instaboard fails. Run
`npx tsx evals/holdout/author.ts --validate-only` to re-apply it yourself; it
also fails if the dump or the prompt has changed since the cases were authored,
because then the committed cases no longer correspond to what the author saw.

## Held out means held out

The cases were generated and committed **before** any arm ran. The git history
is the record: the commit that adds `cases.json` precedes the commit that adds
`evals/results/holdout-scorecard.md`. Nothing was edited, dropped or re-authored
after a score was seen, and the first run is published whatever it says.

If a second independent author is added later, it gets its own cases file and
its own published score. Replacing this set with a better one after seeing how
this one scored is exactly how a held-out set stops being held out.

## Not yet scored, and why

There is no `holdout-scorecard.md` in `evals/results/`. That is deliberate.

The suite has been run once, against a DataHub holding only `showcase-ecommerce`,
on the same free model the two published scorecards used
(`nvidia/nemotron-3-ultra-550b-a55b:free`). It produced 2/18 with the catalog and
9/18 with no tools — the control arm winning, which is not a result, it is a
symptom. The reason is in the raw output: **10 of the 18 grounded cases failed
with `openrouter returned no choices`**, the provider returning an empty
response part-way through a multi-call tool loop. The control arm makes zero
tool calls and one request per case, so it is barely exposed to the failure and
comes out ahead by not participating.

That number measures free-tier reliability under multi-call loads. Publishing it
as a held-out result would misrepresent the tool in the negative direction as
surely as a self-authored benchmark misrepresents it in the positive one, so it
is not published. The run was discarded, not kept and caveated.

What it would take: a provider that can complete a 3–10 call tool loop without
dropping responses. The cases, the catalog dump, the prompt and the harness are
all here and frozen, so scoring it is one command for anyone who has one.

Two things the attempt did establish, which are worth having:

- **The catalog has to be showcase-only.** Run against a DataHub also holding
  this repo's Northbeam catalog, the agent answers these questions from
  Northbeam — "there is no dataset named `order_details`" — because the
  questions were written from a showcase-only dump and the names collide.
- **These questions need more tool calls than the ones we wrote.** The grounded
  arm averaged well over six calls per case here. Whether the published 19/20
  and 20/20 partly reflect questions that resolve in fewer hops is a real
  question this suite could answer, once it can be scored.

## Running it

```bash
npm run datahub:up
DATAHUB_GMS_URL=http://localhost:8080 datahub datapack load showcase-ecommerce

npx tsx evals/holdout/dump-catalog.ts        # regenerate the dump (optional)
npx tsx evals/holdout/author.ts --validate-only
npm run eval -- --live --suite=holdout
```

`npm run eval:verify` re-scores the committed answers for this suite along with
the other two, so the published number stays reproducible from raw answers
without a DataHub or an API key.

| File | What it is |
| --- | --- |
| `dump-catalog.ts` | reads the showcase catalog off a live GMS into `catalog-dump.json` |
| `catalog-dump.json` | the only thing the author was shown, with its sha256 |
| `author-prompt.md` | the only instructions the author was given, verbatim |
| `author.ts` | runs the author, applies the mechanical filter, freezes `cases.json` |
| `cases.json` | the frozen cases, their provenance, and every rejection |
