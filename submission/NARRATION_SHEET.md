# Narration sheet — instaboard-demo-visuals.mp4 (2:40)

Open the MP4 (on your Desktop) in QuickTime, record audio in a voice memo or
QuickTime audio recording, and read each block when its timestamp hits. Then
mux: `ffmpeg -i instaboard-demo-visuals.mp4 -i narration.m4a -c:v copy -shortest instaboard-demo-final.mp4`
— or do a single QuickTime screen-record of the video playing while you talk
over it. Every block fits its slot at a relaxed pace, with air on either side.

Everything on screen is a real run: live chat against DataHub with eight MCP
calls, a live validation, a real write-back fired and repaired on the local
catalog, and the committed benchmark numbers. Long waits are timelapsed;
nothing is mocked.

---

**00:00–00:16 — landing page, scrolls through "Guides name real columns"**

> When a data engineer leaves, the way they did things leaves with them.
> instaboard records how a task is done, saves it as a guide in your DataHub
> catalog, and keeps checking every step against what the catalog holds now.

**00:17–00:30 — chat: question clicked, MCP calls streaming in fast-forward**

> A new hire asks what breaks if users dot email changes. The agent is
> querying a live DataHub through the official MCP server, and every call it
> makes shows up in the trace. Eight, for this one question.

**00:31–00:48 — the answer: impact table, owner, sign-off warning**

> The answer maps the blast radius three hops downstream. It names Mike
> Rodriguez as the person to talk to first, and it flags the churn table where
> Finance signs off. Every table in it exists, straight out of the catalog.

**00:49–01:12 — Priya's guide opens; steps scroll; Validate runs at ~1:05**

> Before Priya left, she recorded her board deck task by doing it once. Each
> step keeps her SQL and her reasons, with a link into DataHub. One click
> re-validates it all against the live catalog. Seventeen of eighteen claims
> still hold, and the step nobody is monitoring is reported as a gap.

**01:13–01:22 — Inject drift: button clicked, write-back panel fills**

> Now break it for real. This button drops the column step two reads, and the
> sweep writes the damage into DataHub as state: one incident, one tag, one
> assertion failing.

**01:23–01:37 — DataHub UI: Stale Runbook tag, then the Incidents tab**

> This is DataHub's own UI. fct_revenue now carries a Stale Runbook tag
> beside the tags it already had, and under incidents the broken guide is
> named, assigned to whoever owns this dataset today.

**01:38–01:50 — Repair it: retraction panel fills**

> Repairing the guide earns the retraction. The incident is resolved and the
> tag comes off, and both of those facts are read back out of DataHub after
> the write, so nothing rests on a receipt.

**01:51–01:56 — DataHub again: tag gone, dataset green**

> Clean again. A detector that only ever adds warnings ends up ignored.

**01:57–02:09 — receipts: npm run prove, terminal card**

> npm run prove walks that whole loop against a live DataHub, breaking it
> through DataHub's own write APIs. Thirty-nine assertions, thirty-nine
> passing, and CI re-derives the receipts from nothing on every push.

**02:11–02:21 — receipts: the three-arm benchmark table**

> Does grounding help? Twenty new-hire questions, scored deterministically,
> with no LLM judge. The grounded agent averages eighteen of twenty. Strip it
> down to warehouse schema and it drops to about nine. With no tools it
> manages three.

**02:23–02:30 — receipts: the drift detection table**

> The detector itself is scored blind against planted drift. Six of six
> found, while every decoy and control stayed quiet. That table re-derives
> offline from the committed run.

**02:31–02:40 — close on the hero**

> instaboard. The catalog you already run, noticing when your team's
> knowledge stops being true. Demo mode takes about a minute. Thanks for
> watching.

---

Upload public or unlisted (never private) → paste the YouTube link into
DEVPOST.md and the Devpost form.
