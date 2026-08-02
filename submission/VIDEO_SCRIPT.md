# Demo video script — 2:50 target (3:00 hard cap)

Judges stop watching at 3:00 sharp, and they score "does the video show it
actually functioning." So: no slides after the cold open, every claim shown
live, the write-back shown *inside the DataHub UI*, and the benchmark on screen
before the close.

**Setup before recording:** live DataHub quickstart seeded (`npm run seed`),
app running, extension installed, DataHub open on the `payment_health_daily`
page. Record at 1080p+, cursor visible. Rehearse once against the clock — the
timings below leave ~10s slack.

---

### 0:00–0:20 — Cold open (problem)

*Screen: a wiki-style runbook doc, scrolling slowly.*

> "This is a runbook a data engineer wrote before she left. It looks
> authoritative. Step 1 is wrong — the table it depends on went stale two weeks
> after she wrote it — and nothing on this page will ever tell you that.
> When people leave data teams, this is what they leave behind."

### 0:20–0:35 — What instaboard is

*Screen: cut to DataHub UI with the instaboard side panel open next to it.*

> "instaboard is a DataHub-native agent that captures a leaving engineer's
> knowledge into the catalog, replays it for whoever inherits the job — and
> tells you when it goes stale. It lives where the work happens: a side panel
> inside DataHub."

### 0:35–1:15 — Capture (the headline loop)

*Screen: click ● Record in the side panel. Navigate DataHub naturally:
`payment_health_daily` → `fct_revenue` → `mrr_monthly`, typing a one-line
"why" on each step. Stop recording; show the agent enriching steps (owners,
saved SQL, lineage appearing); click save.*

> "Priya's leaving. She hits Record and just does her monthly task. Every
> DataHub page becomes a step; she adds the why — the thing that's never in
> the docs. The agent enriches each step from the live catalog: the real
> owners, the actual saved SQL, the lineage. And here's the part that matters —"

*Screen: switch to the DataHub UI, show the runbook as a Document in DataHub,
linked to the datasets it touches.*

> "— the finished runbook is written back into DataHub with the MCP
> save_document tool, linked to the datasets it touches. Her knowledge now
> lives next to the data, not in a wiki nobody checks."

### 1:15–1:45 — Inherit (replay)

*Screen: side panel in replay mode; navigate DataHub following steps; show the
"you're on this page" indicator lighting up; open "ask the coach" on one step
and show a grounded answer with the tool trace expanding.*

> "Three months later, her successor replays it step by step, next to the real
> DataHub pages — the panel knows which page you're on. Stuck on a step? Ask
> the coach: every answer is grounded in the catalog, and every MCP call is
> visible in the trace. No hallucinated table names."

### 1:45–2:25 — Validate (decay detection + write-back)

*Screen: /handoffs → sample runbook → click **Validate against DataHub**. The
warning appears on step 1. Then cut to DataHub showing the "Stale runbook"
Note attached to `payment_health_daily`.*

> "But captured knowledge rots — and this is the loop everyone else skips.
> One click re-validates every step against live DataHub. Step 1 just failed:
> the freshness assertion on payment_health_daily started failing *after* the
> runbook was recorded. This check is deterministic — a schema diff and a
> health read, no LLM — so you can confirm the verdict in the DataHub UI in
> ten seconds. And the finding is written back to the catalog too, so the
> warning lives where the runbook lives. The catalog validates the docs."

### 2:25–2:45 — Proof (benchmark)

*Screen: scorecard.md — the headline table, then a quick scroll through two
case details (the hallucination case is the memorable one).*

> "Does grounding in DataHub actually matter? We measured it: a 20-question
> new-hire benchmark, scored deterministically against the catalog — real
> URNs, real owners, no LLM judge. Same agent, same model: 15 out of 20 with
> DataHub's MCP tools, 5 without. Asked about a table that doesn't exist, the
> grounded agent says so; the control invents a schema."

### 2:45–2:55 — Close

*Screen: repo README top, then the side panel one last beat.*

> "instaboard: capture knowledge into DataHub, inherit it next to DataHub,
> and let DataHub tell you when it's stale. Runs in two minutes with zero
> infrastructure — demo mode is in the README. Thanks for watching."

---

## Recording notes

- **The one shot that wins the video** is the cut from "agent saved the
  runbook" to *the DataHub UI showing it as a Document* (0:35–1:15) and again
  for the stale-runbook Note (1:45–2:25). Judges reward write-back they can
  see in DataHub itself, not in our app. Linger a full 3 seconds on each.
- If the live stack misbehaves on recording day, everything except the two
  in-DataHub shots works identically in `DEMO_MODE=true`; record those two
  shots first while the stack is healthy.
- No background music (rules prohibit copyrighted audio; silence + voiceover
  is safer and clearer anyway).
- Upload unlisted-or-public on YouTube (private videos can't be judged —
  several competitors have already burned their video slot this way).
