# Narration sheet — instaboard-demo-visuals.mp4 (2:24)

Open the MP4 (on your Desktop) in QuickTime, hit record in a voice memo or
QuickTime audio recording, and read each block when the timestamp hits. Then
mux: `ffmpeg -i instaboard-demo-visuals.mp4 -i narration.m4a -c:v copy -shortest instaboard-demo-final.mp4`
— or just do a single QuickTime screen-record of the video playing while you
talk over it. Total speaking time per block is comfortable at a natural pace.

---

**00:00–00:20 — landing page, scrolls to "Runbooks rot" band**

> This is instaboard. When a data engineer leaves, their knowledge leaves with
> them — and when someone joins, they spend weeks finding out which of four
> revenue tables is the real one. instaboard fixes both halves, on top of the
> DataHub catalog you already run.

**00:20–01:02 — chat: question typed, MCP tool trace streams, answer renders**

> A new hire asks: is it safe to build a report on the raw events table? Watch
> the trace — the agent is querying DataHub live through the official MCP
> server: search, entity read, health check, usage stats. And the answer: that
> table was deprecated in November — build on events_sessionized instead, here's
> the owner. No hallucinated table names. Every claim comes from the catalog,
> with the URN to prove it.

**01:02–01:21 — handoffs: Priya's runbook opens, steps with why + real SQL**

> Before Priya left, she recorded her monthly board-deck task by just doing it.
> instaboard turned her trail into a runbook: each step has the instruction, the
> why that was never in any doc, the real saved SQL, and a link to the exact
> dataset in DataHub.

**01:21–01:33 — still: the runbook note inside the DataHub UI**

> And it doesn't live in a wiki — it's written back into DataHub with the MCP
> save_document tool, linked to the datasets it touches. Her knowledge lives
> next to the data.

**01:33–01:54 — Validate against DataHub runs live, warning appears**

> But captured knowledge rots — so here's the loop everyone else skips. One
> click re-validates every step against live DataHub. Step one just failed: the
> freshness assertion on payment_health_daily started failing after Priya
> recorded this. The check is deterministic — a schema diff and a health read,
> no LLM — and the finding is written back to the catalog, flagged in DataHub.

**01:54–02:03 — still: the failing assertion in DataHub's Quality tab**

> There's the assertion it caught, in DataHub itself. You can verify the verdict
> in ten seconds.

**02:03–02:18 — benchmark band, dots fill: 19/20 vs 5/20**

> Does grounding actually matter? We measured it. Twenty new-hire questions,
> scored deterministically against the catalog — no LLM judge. Same agent, same
> model: nineteen out of twenty with DataHub's MCP tools. Five without. And CI
> re-verifies that score from the committed answers on every push.

**02:18–02:24 — close on the hero**

> instaboard. Capture knowledge into DataHub, inherit it next to DataHub, and
> let DataHub tell you when it's stale. Demo mode runs in two minutes — link in
> the repo. Thanks for watching.

---

Upload public or unlisted (never private) → paste the YouTube link into
DEVPOST.md and the Devpost form.
