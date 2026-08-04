# Proposed corrections

What the tool does *after* it finds drift.

[`monthly-revenue-close.md`](monthly-revenue-close.md) is real output from
`npm run prove`. A runbook was captured against a live catalog, three breaking
changes were then made to that catalog through DataHub's own write APIs, and this
is the correction the sweep derived by re-reading it.

Worth noticing:

- **Every edit names its evidence.** "`net_revenue_usd` is on fct_revenue now and
  was not when this runbook was recorded, and it is the closest match to
  `net_amount_usd`." Nothing was generated. The catalog was read.
- **The `Needs a person` section.** The deprecation note named a replacement
  *table* and gave no URN, so the step's entity link could not be repointed
  safely. Saying so is the useful thing to do with a half-fix.
- **Confidence is downgraded when prose was touched.** "ping Mike Rodriguez — he
  owns the dbt job" cannot become "ping Priya Patel — he owns the dbt job", so the
  pronoun gets repointed too, and the edit is marked `medium` for a human to read.
- **The reviewers are the current owners**, read from the catalog at validation
  time. In the owner-drift case that is exactly the person the runbook did not
  know about.

Nothing is applied automatically. `npm run propose -- --apply` accepts the
correction into the runbook store, and `npm run propose -- --pr` opens it as a
pull request against the runbook files in [`../runbooks/`](../runbooks). Both are
explicit, because a document whose whole value is that a colleague trusted it
should not be rewritten by a cron job.
