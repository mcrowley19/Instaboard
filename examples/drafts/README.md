# Drafted runbooks

Runbooks the tool wrote **with nobody recording anything**, from evidence the
catalog already held: recorded queries, lineage, ownership, health.

```bash
npm run draft -- --query=revenue          # best candidates matching a search
npm run draft -- --urn="urn:li:dataset:…" # one specific dataset
npm run draft -- --query=orders --save    # keep them, and write back to DataHub
```

This is what removes the cold start. The capture loop needs a departing engineer
to sit down and record, which is the scarcest hour in the building; a draft turns
that into correcting a page that already exists.

## What to look for

**The labelling.** Every draft says "Draft runbook — nobody recorded this", every
inferred reason is marked `Why (inferred from the catalog)`, and drafts are
attributed to the tool rather than to a person. That is deliberate: the reason
step 2 exists is not in any catalog, and a draft that read like a colleague wrote
it would be worse than no draft at all.

**The evidence line.** Each draft states what it was built from — how many
recorded queries, how many upstreams and downstreams, how many owners. If that
line is thin, the draft is thin, and you can see it at a glance rather than
discovering it three steps in.

**What it refuses to do.** Pointed at a dataset with no recorded queries and no
lineage, the drafter returns nothing rather than padding a name and a schema into
a confident-sounding document.

**The SQL is real.** Query steps carry SQL the catalog has on record against that
table, never a reconstruction.

Drafts snapshot a decay baseline like any other runbook, so they rot and get
caught the same way: `npm run validate`.
