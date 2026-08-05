"use client";

import Link from "next/link";
import DriftPlayground from "@/components/DriftPlayground";
import WriteBackPlayground from "@/components/WriteBackPlayground";
import "./landing.css";

const STEPS = [
  { call: "search", arg: 'query: "events"', ret: "2 datasets across postgres + snowflake" },
  { call: "get_entities", arg: "postgres,northbeam_app.public.events", ret: "owned by James Okafor and Sarah Chen · domain Growth" },
  { call: "get_dataset_health", arg: "same urn", ret: "deprecated 2025-11-01 → analytics.marts.events_sessionized" },
  { call: "get_usage_stats", arg: "window: 30d", ret: "74 queries, trending down" },
];

const CAPABILITIES: [string, string, string][] = [
  ["What tables do we use for revenue?", "search → get_entities", "fct_revenue and mrr_monthly, with owners and URNs"],
  ["How do we calculate MRR?", "get_entities", "the glossary definition, plus related terms like ARR"],
  ["What breaks if I change users.email?", "get_lineage", "the downstream marts affected, and who to warn"],
  ["Show me SQL for churn analysis", "get_dataset_queries", "the saved query someone already wrote against fct_churn"],
  ["Which Payments tables should I learn first?", "get_usage_stats", "an order built from what people query"],
  ["Is this table safe to build a report on?", "get_dataset_health", "deprecation, open incidents, and failing assertions"],
  ["Why is there no description here?", "save_document", "a drafted description, filed for an owner to approve"],
];

const STATS: { stat: string; claim: string; source: string; href: string }[] = [
  {
    stat: "42%",
    claim: "of institutional knowledge is unique to one person. When they leave, no copy exists.",
    source: "YouGov for Panopto, n=1,001, 2018",
    href: "https://www.prnewswire.com/news-releases/inefficient-knowledge-sharing-costs-large-businesses-47-million-per-year-300681971.html",
  },
  {
    stat: "5.3 hrs",
    claim: "lost per knowledge worker every week, waiting for colleagues’ knowledge or recreating it.",
    source: "same survey",
    href: "https://www.prnewswire.com/news-releases/inefficient-knowledge-sharing-costs-large-businesses-47-million-per-year-300681971.html",
  },
  {
    stat: "41%",
    claim: "of data teams name ambiguous data ownership as an obstacle to their work.",
    source: "dbt Labs, State of Analytics Engineering, n=363, 2026",
    href: "https://www.prnewswire.com/news-releases/new-dbt-labs-report-finds-ai-driven-acceleration-is-outpacing-trust-and-governance-302741246.html",
  },
];

const BENCH: { label: string; sub: string; score: number; mean: string; kind: "sig" | "mute" }[] = [
  { label: "with DataHub", sub: "same agent, MCP tools on", score: 18, mean: "18.0", kind: "sig" },
  { label: "warehouse schema only", sub: "same agent, information_schema and nothing else", score: 9, mean: "8.7", kind: "mute" },
  { label: "without", sub: "same agent, no catalog", score: 3, mean: "3.0", kind: "mute" },
];

const LANES: { where: string; title: string; steps: React.ReactNode[] }[] = [
  {
    where: "web app · Chat",
    title: "Ask the catalog something",
    steps: [
      <>Run <code>npm run dev</code> and open <code>localhost:3000</code>. It lands on Chat.</>,
      <>Paste an LLM key into <b>Settings</b> in the left sidebar, unless you already put one in <code>.env.local</code>.</>,
      <>Type a question, or click one of the five starters sitting on the empty state.</>,
      <>The tool trace above the answer shows each DataHub call it made.</>,
    ],
  },
  {
    where: "Chrome side panel",
    title: "Record what you know",
    steps: [
      <>Load <code>extension/</code> unpacked at <code>chrome://extensions</code>, then pin the icon and click it.</>,
      <>Open the DataHub page you would normally start from and hit <b>● Record</b> in the panel header.</>,
      <>Do the task. Each page you land on becomes a step, and <b>Add note</b> attaches the why to the step you are on.</>,
      <>Hit <b>■ Stop</b>, name the task, and click <b>Generate guide &amp; save to DataHub</b>.</>,
    ],
  },
  {
    where: "web app · Handoffs",
    title: "Find out when it breaks",
    steps: [
      <>Open <b>Handoffs</b> and pick a guide. Every step shows the action, the why, the real SQL and the gotchas.</>,
      <>Click <b>Validate against DataHub</b>. It re-reads every entity the guide depends on and reports what moved.</>,
      <>A broken guide gets a tag, a failing assertion and an incident on the datasets involved, over in DataHub.</>,
      <>Run <code>npm run propose</code> to get the correction as a diff.</>,
    ],
  },
];

const PHASES = [
  {
    who: "you",
    title: "Record",
    body: "Open the side panel, press record, and do the task the way you always do it. Every DataHub page you land on gets captured as a step.",
  },
  {
    who: "you",
    title: "Annotate",
    body: "Type the why next to each step, such as the reason one column gets filtered out before any of the numbers make sense.",
  },
  {
    who: "instaboard",
    title: "Enrich",
    body: "The agent looks up every step in the catalog and attaches owners, saved SQL, lineage and tags.",
  },
  {
    who: "new hire",
    title: "Replay",
    body: "Whoever picks the task up replays it in the same panel, and each step lights up when their browser lands on the page it describes.",
  },
];

function ChromeLogo() {
  return (
    <svg className="chrome-logo" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#ea4335"
        d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z"
      />
      <path
        fill="#fbbc04"
        d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z"
      />
      <path
        fill="#34a853"
        d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z"
      />
      <circle cx="24" cy="24" r="12" fill="#fff" />
      <circle cx="24" cy="24" r="9.5" fill="#1a73e8" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M2 8h11M9 4l4 4-4 4" />
    </svg>
  );
}

export default function Landing() {
  return (
    <div className="lp">
      <header className="lp-bar">
        <div className="lp-mark">
          <i>i</i> instaboard
        </div>
        <nav className="lp-bar-meta">
          <Link className="go" href="/chat">
            open the app
          </Link>
        </nav>
      </header>

      <section className="lp-head">
        <div className="lp-head-hero">
          <h1>
            <span className="lp-line">
              <span>Onboarding for</span>
            </span>
            <span className="lp-line">
              <span>data teams, built</span>
            </span>
            <span className="lp-line">
              <span>
                <em>on DataHub.</em>
              </span>
            </span>
          </h1>

          <div className="lp-glyph" aria-hidden="true">
            i
          </div>
        </div>

        <div className="lp-head-body">
          <div>
            <p className="lp-lede">
              <strong>instaboard</strong> saves how your team does a task as a step-by-step
              guide, then keeps checking that guide against your DataHub catalog. New hires
              ask it questions in chat and get answers from the live catalog, real table
              names included.
            </p>
            <div className="lp-acts">
              <Link className="lp-cta" href="/chat">
                Ask it something <Arrow />
              </Link>
              <a className="lp-alt" href="#start">
                or run it locally
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="band lp-stats-band">
        <div className="band-grid">
          <div className="lp-stats">
            {STATS.map((s) => (
              <div className="lp-stat" key={s.stat}>
                <div className="lp-stat-num">{s.stat}</div>
                <p className="lp-stat-claim">{s.claim}</p>
                <a className="lp-stat-src" href={s.href} target="_blank" rel="noreferrer">
                  {s.source}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="band" id="story">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">Guides name real columns, tables and owners.</h2>
            <p className="lp-sub">
              Every guide points at real things in the catalog: the columns its SQL sums,
              the tables it reconciles against, the owner it says to ping. All of that keeps
              changing, and a guide has no way to notice on its own. So instaboard re-checks
              every guide against DataHub and pins each mismatch to the step it breaks.
            </p>

            <div className="lp-shot-row">
              <div className="lp-shot-frame">
                <img
                  src="/screenshots/handoff-validation.png"
                  alt="The Handoffs page after a validation run: the guide is marked Out of date with four findings, including the missing column and the changed owner"
                  width={838}
                  height={1000}
                  loading="lazy"
                />
              </div>
              <div className="lp-shot-side">
                <p>
                  This is that check running in the app. A month after the guide was
                  recorded, validation comes back <b>Out of date</b> with four findings: the
                  revenue column was renamed, the rollup table was deprecated, a freshness
                  assertion started failing, and the person the guide says to ping no longer
                  owns the table.
                </p>
                <p>
                  Each finding sits on the step that uses it, with the drift spelled out and
                  a correction proposed. The same run writes back to DataHub, where the
                  dataset gets a warning tag and an incident goes to its current owner.
                </p>
                <p>
                  <a href="#decay">Break it yourself below</a> and watch the verdict change.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band" id="answers">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">It works off the catalog you already run.</h2>
            <p className="lp-sub">
              Nothing here is pre-written. Every question sends the agent to DataHub while
              you wait, so the answer reflects whatever the catalog holds at that moment.
              Below is a real run against the demo catalog: four tool calls, then an answer
              that cites the URN it found.
            </p>

            <div className="lp-trace">
              <div className="lp-trace-head">
                <span className="dot" />
                <span>agent transcript</span>
                <span className="grow">northbeam · demo catalog</span>
              </div>

              <div className="lp-ask">
                <span>asked</span>
                Is it safe to build a report on the raw events table?
              </div>

              <ol className="lp-steps">
                {STEPS.map((s) => (
                  <li key={s.call} className="lp-step on">
                    <span className="tick">●</span>
                    <span>
                      <b>{s.call}</b> <span className="arg">{s.arg}</span>
                      <span className="ret">{s.ret}</span>
                    </span>
                  </li>
                ))}
              </ol>

              <div className="lp-answer on">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M12 3.5 2.5 20h19L12 3.5Z" strokeLinejoin="round" />
                  <path d="M12 10v4.5M12 17.4v.2" strokeLinecap="round" />
                </svg>
                <p>
                  That table was deprecated on 2025-11-01 and is kept around for pipeline debugging.
                  Build on <code>events_sessionized</code> instead, the sessionized mart James Okafor
                  owns. Volume on the raw firehose has been sliding all quarter.
                  <span className="cite">
                    urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.events_sessionized,PROD)
                  </span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">What you can ask it.</h2>
            <p className="lp-sub">
              A sample of week-one questions and what comes back. The middle column is the
              DataHub call the agent chose, and the right column is what a new hire actually
              gets, with names, owners and definitions pulled from the catalog. Every row
              works in the demo the moment the app starts.
            </p>
            <table className="lp-table">
              <thead>
                <tr>
                  <th>Ask</th>
                  <th>Calls</th>
                  <th>Comes back</th>
                </tr>
              </thead>
              <tbody>
                {CAPABILITIES.map(([ask, calls, back]) => (
                  <tr key={ask}>
                    <td>{ask}</td>
                    <td>{calls}</td>
                    <td>{back}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="band" id="use">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">What you actually do with it.</h2>
            <p className="lp-sub">
              Three surfaces, and the same agent behind all of them. Chat answers questions,
              the side panel explains whatever DataHub page you are on, and Handoffs holds
              the recorded guides. Everything below runs on a laptop with{" "}
              <code>npm run dev</code> and a DataHub you can reach.
            </p>

            <p className="lp-note">
              The sidebar adds three more pages. <b>Learning Path</b> builds a week-one plan
              for a role, <b>Lineage</b> explains what feeds a dataset and what it breaks,
              and <b>Progress</b> tracks the plan. From a terminal, <code>npm run draft</code>{" "}
              writes guides straight from the catalog and <code>npm run validate</code>{" "}
              checks every stored guide.
            </p>

            <div>
              <div className="lp-use">
                {LANES.map((lane) => (
                  <div className="lp-lane" key={lane.title}>
                    <span className="lane-where">{lane.where}</span>
                    <h3>{lane.title}</h3>
                    <ol>
                      {lane.steps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band" id="extension">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">
              <ChromeLogo /> A Chrome extension that rides along inside DataHub.
            </h2>
            <p className="lp-sub">
              The Chrome extension reads the URN of whatever DataHub page you have open and
              explains it right there, so you stay on the page. It runs as a thin client on
              the same agent, which keeps API keys out of the browser. The chips under the
              answer cover the common asks, including recording a handoff without leaving
              the tab.
            </p>

            <p className="lp-note">
              Installing takes a minute: download the zip, unzip it, open{" "}
              <code>chrome://extensions</code>, turn on Developer mode, and hit{" "}
              <b>Load unpacked</b>. It also ships in the repo&rsquo;s{" "}
              <a
                href="https://github.com/mcrowley19/Instaboard/tree/main/extension"
                target="_blank"
                rel="noreferrer"
              >
                extension/ folder
              </a>
              .
            </p>

            <div className="lp-acts">
              <a className="lp-cta" href="/instaboard-extension.zip" download>
                Download the extension <Arrow />
              </a>
            </div>

            <div className="lp-ext" aria-hidden="true">
              <div className="lp-ext-chrome">
                <span className="dots">
                  <i /><i /><i />
                </span>
                <span className="url">acme.datahub.com/dataset/fct_revenue</span>
              </div>
              <div className="lp-ext-body">
                <div className="lp-ext-dh">
                  <div className="dh-title">
                    fct_revenue <span>snowflake · prod</span>
                  </div>
                  <div className="dh-label">schema</div>
                  <div className="sk" style={{ width: "72%" }} />
                  <div className="sk" style={{ width: "58%" }} />
                  <div className="sk" style={{ width: "64%" }} />
                  <div className="dh-label">lineage</div>
                  <div className="sk" style={{ width: "80%" }} />
                  <div className="sk" style={{ width: "46%" }} />
                  <div className="dh-label">queries</div>
                  <div className="sk" style={{ width: "66%" }} />
                  <div className="sk" style={{ width: "52%" }} />
                </div>
                <aside className="lp-ext-panel">
                  <div className="lp-ext-head">
                    <i>i</i> instaboard <span className="key">side panel</span>
                  </div>
                  <div className="lp-ext-urn">on this page: fct_revenue</div>
                  <div className="lp-ext-q">Explain this table</div>
                  <p className="lp-ext-a">
                    Finance&rsquo;s revenue mart, owned by Sarah Chen. Fed by{" "}
                    <b>stripe_payments</b> and <b>orders</b>; 212 queries this month. One freshness
                    assertion has been failing since Tuesday, so check before you report off it.
                  </p>
                  <div className="lp-chips">
                    <span>explain this table</span>
                    <span>who owns it</span>
                    <span>record a handoff</span>
                  </div>
                </aside>
              </div>
            </div>

          </div>
        </div>
      </section>

      <section className="band" id="handoffs">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">Guides get recorded by doing the task.</h2>
            <p className="lp-sub">
              Writing documentation is a separate job nobody has time for, so the recording
              rides along with the work itself. Press record in the side panel and do the
              task the way you always do it, typing the why next to each step as you go. The
              agent fills in the rest from the catalog, and the finished guide is saved back
              into DataHub through <code>save_document</code>, linked to the datasets it
              touches.
            </p>

            <div className="lp-ruler">
              <div className="lp-phases">
                {PHASES.map((p) => (
                  <div className="lp-phase" key={p.title}>
                    <h3>
                      <span className="who">{p.who}</span>
                      {p.title}
                    </h3>
                    <p>{p.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band" id="decay">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">Break the catalog and watch validation catch it.</h2>
            <p className="lp-sub">
              Pick a change below and the validator re-checks the guide against the catalog,
              live on this page. It catches missing columns, deprecated tables, failing
              assertions and changed owners. The check is a plain diff with no LLM involved,
              so any verdict can be confirmed in the DataHub UI. Against a real catalog the
              result is written back as a failing assertion, a warning tag and an incident
              for the current owner.
            </p>

            <div>
              <DriftPlayground />
            </div>

            {/* Renders only where the deployment has a DataHub it is allowed to
                write to. Everywhere else it is absent rather than disabled. */}
            <WriteBackPlayground />
          </div>
        </div>
      </section>

      <section className="band" id="proof">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">Does the catalog help? We measured it.</h2>
            <p className="lp-sub">
              Twenty questions a new hire asks in week one, answered by the same agent
              under three setups. Scoring is deterministic, and no LLM judges anything.
              The middle arm gets what a bare warehouse connection returns, which is how
              you find out the metadata is doing the work. When a question names a table
              that doesn&rsquo;t exist, the grounded agent says so and the control
              invents a schema.{" "}
              <a
                href="https://github.com/mcrowley19/Instaboard/blob/main/evals/results/scorecard.md"
                target="_blank"
                rel="noreferrer"
              >
                Read the scorecard
              </a>{" "}
              or run it yourself: <code>DEMO_MODE=true npm run eval</code>.
            </p>

            <div className="lp-bench">
              {BENCH.map((arm) => (
                <div className={`lp-arm ${arm.kind}`} key={arm.label}>
                  <div className="lp-arm-head">
                    <b>{arm.label}</b>
                    <span className="key">{arm.sub}</span>
                  </div>
                  <div className="lp-arm-dots" role="img" aria-label={`mean ${arm.mean} of 20 across three live passes`}>
                    {Array.from({ length: 20 }, (_, i) => (
                      <span key={i} className={i < arm.score ? "on" : ""} />
                    ))}
                  </div>
                  <div className="lp-arm-score">
                    {arm.mean}
                    <span>/20</span>
                  </div>
                </div>
              ))}
            </div>

            <p className="lp-bench-note">
              Means over three passes against a live catalog; the spreads are in the
              scorecard, and the ranges of the arms never touch. On DataHub&rsquo;s own
              showcase datapack, 1,065 entities this repo did not author, the grounded
              arm scored 20/20.
            </p>

          </div>
        </div>
      </section>

      <section className="band lp-install" id="start">
        <div className="band-grid">
          <div>
            <h2 className="lp-h2">Running in about a minute.</h2>
            <p className="lp-sub">
              Demo mode answers every catalog call from a built-in fixture of Northbeam, a
              subscription-commerce catalog with 14 datasets, four owners and real lineage.
              It needs nothing beyond an LLM key. Pointing it at a live catalog takes two
              more commands, <code>npm run datahub:up</code> and <code>npm run seed</code>,
              covered in the README.
            </p>

            <div className="lp-shell">
              <div>
                <span className="p">$</span>npm install
              </div>
              <div>
                <span className="p">$</span>echo &quot;DEMO_MODE=true&quot; &gt; .env.local
              </div>
              <div>
                <span className="p">$</span>npm run dev
              </div>
              <div>
                <span className="p"> </span>
                <span className="c"># then paste an LLM key in Settings</span>
              </div>
            </div>

          </div>
        </div>
      </section>

      <div className="lp-foot-wrap">
        <footer className="lp-foot">
          <span>instaboard v0.1.0</span>
          <a href="https://github.com/mcrowley19/Instaboard" target="_blank" rel="noreferrer">
            github
          </a>
          <a href="https://docs.datahub.com/docs/quickstart" target="_blank" rel="noreferrer">
            datahub quickstart
          </a>
          <a href="https://github.com/acryldata/mcp-server-datahub" target="_blank" rel="noreferrer">
            mcp-server-datahub
          </a>
          <Link className="push" href="/chat">
            open the app ↗
          </Link>
        </footer>
      </div>
    </div>
  );
}
