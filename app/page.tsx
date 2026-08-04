"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
  ["What tables do we use for revenue?", "search → get_entities", "fct_revenue and mrr_monthly, with the owner and a URN you can paste straight into DataHub"],
  ["How do we calculate MRR?", "get_entities", "the glossary definition, and the terms sitting next to it like ARR and Churn Rate"],
  ["What breaks if I change users.email?", "get_lineage", "the downstream marts that would go red, and the people to warn before you ship"],
  ["Show me SQL for churn analysis", "get_dataset_queries", "the saved query someone already wrote against fct_churn"],
  ["Which Payments tables should I learn first?", "get_usage_stats", "an order built from what people query"],
  ["Is this table safe to build a report on?", "get_dataset_health", "whether it is deprecated, what incidents are open, and any freshness assertion that has been failing"],
  ["Why is there no description here?", "save_document", "a proposal drafted from the schema and lineage it just read, filed for an owner to approve"],
];

const BENCH: { label: string; sub: string; score: number; kind: "sig" | "mute" }[] = [
  { label: "with DataHub", sub: "same agent, MCP tools on", score: 19, kind: "sig" },
  { label: "without", sub: "same agent, no catalog", score: 5, kind: "mute" },
];

const LANES: { where: string; title: string; steps: React.ReactNode[] }[] = [
  {
    where: "web app · Chat",
    title: "Ask the catalog something",
    steps: [
      <>Run <code>npm run dev</code> and open <code>localhost:3000</code>. It lands on Chat.</>,
      <>Paste an LLM key into <b>Settings</b> in the left sidebar, unless you already put one in <code>.env.local</code>.</>,
      <>Type a question, or click one of the five starters sitting on the empty state.</>,
      <>The tool trace above the answer expands to show each DataHub call the agent made and what came back.</>,
    ],
  },
  {
    where: "Chrome side panel",
    title: "Record what you know",
    steps: [
      <>Load <code>extension/</code> unpacked at <code>chrome://extensions</code>, then pin the icon and click it.</>,
      <>Open the DataHub page you would normally start from and hit <b>● Record</b> in the panel header.</>,
      <>Do the task. Each page you land on becomes a step, and <b>Add note</b> attaches the why to the step you are on.</>,
      <>Hit <b>■ Stop</b>, name the task, and click <b>Generate runbook &amp; save to DataHub</b>.</>,
    ],
  },
  {
    where: "web app · Handoffs",
    title: "Find out when it breaks",
    steps: [
      <>Open <b>Handoffs</b> and pick the runbook. Every step shows the action, the why, the real SQL and the gotchas.</>,
      <>Click <b>Validate against DataHub</b>. It re-reads every entity the runbook depends on and reports what moved.</>,
      <>A broken runbook gets a tag, a failing assertion and an incident on the datasets involved, over in DataHub.</>,
      <>Run <code>npm run propose</code> for the correction as a diff you can read, then <code>--apply</code> or <code>--pr</code> it.</>,
    ],
  },
];

const PHASES = [
  {
    who: "leaving",
    title: "Record",
    body: "Open the side panel, press record, and do the task the way you always do it. Every DataHub page you land on gets captured as a step.",
  },
  {
    who: "leaving",
    title: "Annotate",
    body: "Type the why next to each step, such as the reason one column gets filtered out before any of the numbers make sense.",
  },
  {
    who: "instaboard",
    title: "Enrich",
    body: "The agent walks the catalog for every step it was handed, then attaches owners, saved SQL, upstream lineage and tags.",
  },
  {
    who: "joining",
    title: "Inherit",
    body: "Whoever picks the task up replays it in the same panel, and each step lights up when their browser lands on the page it describes.",
  },
];

/** Adds `in` once the element has been on screen, one time only. */
function useReveal<T extends HTMLElement>(rootMargin = "-12% 0px") {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("in");
          io.disconnect();
        }
      },
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return ref;
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M2 8h11M9 4l4 4-4 4" />
    </svg>
  );
}

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const [played, setPlayed] = useState(0);
  const tableRef = useReveal<HTMLTableElement>();
  const storyRef = useReveal<HTMLDivElement>();
  const rulerRef = useReveal<HTMLDivElement>();
  const extRef = useReveal<HTMLDivElement>();
  const decayRef = useReveal<HTMLDivElement>();
  const benchRef = useReveal<HTMLDivElement>();
  const usageRef = useReveal<HTMLDivElement>();

  // Step through the tool trace once, when it first scrolls into view.
  useEffect(() => {
    const el = traceRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setPlayed(STEPS.length + 1);
      return;
    }
    // Hidden-until-revealed states only exist once JS can undo them.
    rootRef.current?.classList.add("anim");
    let timer: ReturnType<typeof setInterval>;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        timer = setInterval(() => {
          setPlayed((n) => {
            if (n >= STEPS.length + 1) {
              clearInterval(timer);
              return n;
            }
            return n + 1;
          });
        }, 620);
      },
      { rootMargin: "-20% 0px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="lp" ref={rootRef}>
      <header className="lp-bar">
        <div className="lp-mark">
          <i>i</i> instaboard
        </div>
        <nav className="lp-bar-meta">
          <a href="#answers" className="hide-sm">
            answers
          </a>
          <a href="#use" className="hide-sm">
            using it
          </a>
          <a href="#extension" className="hide-sm">
            extension
          </a>
          <a href="#handoffs" className="hide-sm">
            handoffs
          </a>
          <a href="#proof" className="hide-sm">
            proof
          </a>
          <a href="#start" className="hide-sm">
            install
          </a>
          <a href="https://github.com/mcrowley19/Instaboard" target="_blank" rel="noreferrer">
            github
          </a>
          <Link className="go" href="/chat">
            open the app
          </Link>
        </nav>
      </header>

      <section className="lp-head">
        <div className="lp-head-hero">
          <h1>
            <span className="lp-line">
              <span>The person who built</span>
            </span>
            <span className="lp-line">
              <span>your pipeline left</span>
            </span>
            <span className="lp-line">
              <span>
                <em>in July.</em>
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
              <strong>instaboard</strong> turns what they knew into runbooks that live in
              DataHub, and keeps checking that the catalog still agrees with them. New hires
              ask it questions and get answers off the live catalog, with real table names
              and a URN you can paste into DataHub.
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

      <section className="band" id="story">
        <div className="band-grid">
          <div className="band-rail">the problem</div>
          <div>
            <h2 className="lp-h2">The runbook they left behind still reads fine.</h2>
            <p className="lp-sub">
              Monthly revenue close, three steps, recorded in July by the person who ran it.
              Here is what the catalog did to it by August.
            </p>

            <div className="lp-story" ref={storyRef}>
              <div className="lp-story-col">
                <div className="tickmark" />
                <span className="when">July · as recorded</span>
                <p>
                  Check <code>payment_health_daily</code> before trusting anything downstream.
                  Sum <code>net_amount_usd</code> from <code>fct_revenue</code>, and ping{" "}
                  <b>Mike Rodriguez</b> if the total looks short. Reconcile against{" "}
                  <code>mrr_monthly</code> before finance quotes anything.
                </p>
              </div>
              <div className="lp-story-col aug">
                <div className="tickmark" />
                <span className="when">August · the catalog now</span>
                <p>
                  The column is called <code>net_revenue_usd</code>. <code>mrr_monthly</code>{" "}
                  carries a deprecation notice pointing somewhere else. Mike doesn&rsquo;t own
                  the load job anymore. Every step reads exactly as it did in July.
                </p>
              </div>
            </div>

            <p className="lp-note">
              instaboard re-checks the runbook against live DataHub and turns that gap into
              state on the datasets involved: a failing assertion, a <b>Stale Runbook</b> tag,
              and an incident assigned to the table&rsquo;s current owner.{" "}
              <a href="#decay">Break it yourself below</a>, or run <code>npm run prove</code>{" "}
              to watch a real catalog get broken and caught, 39 assertions on the way through.
            </p>
          </div>
        </div>
      </section>

      <section className="band" id="answers">
        <div className="band-grid">
          <div className="band-rail">answering</div>
          <div>
            <h2 className="lp-h2">It works off the catalog you already run.</h2>
            <p className="lp-sub">
              Nothing here is pre-written. Every question sends the agent to query DataHub on
              the spot, through the official DataHub MCP server, so what comes back is what the
              warehouse holds today.
            </p>

            <div className="lp-trace" ref={traceRef}>
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
                {STEPS.map((s, i) => (
                  <li key={s.call} className={`lp-step ${played > i ? "on" : ""}`}>
                    <span className="tick">{played > i ? "●" : "○"}</span>
                    <span>
                      <b>{s.call}</b> <span className="arg">{s.arg}</span>
                      <span className="ret">{s.ret}</span>
                    </span>
                  </li>
                ))}
              </ol>

              <div className={`lp-answer ${played > STEPS.length ? "on" : ""}`}>
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
          <div className="band-rail">what to ask</div>
          <div>
            <h2 className="lp-h2">Week one is mostly questions.</h2>
            <table className="lp-table" ref={tableRef}>
              <thead>
                <tr>
                  <th>Ask</th>
                  <th>Calls</th>
                  <th>Comes back</th>
                </tr>
              </thead>
              <tbody>
                {CAPABILITIES.map(([ask, calls, back], i) => (
                  <tr key={ask} style={{ animationDelay: `${i * 70}ms` }}>
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
          <div className="band-rail">using it</div>
          <div>
            <h2 className="lp-h2">What you actually do with it.</h2>
            <p className="lp-sub">
              Three surfaces, and the same agent behind all of them. Everything below runs on a
              laptop with <code>npm run dev</code> and a DataHub you can reach.
            </p>

            <div className="lp-reveal" ref={usageRef}>
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

            <p className="lp-note">
              The web app carries three more pages off the same sidebar. <b>Learning Path</b> takes
              a role and a domain and builds a week-one plan out of live catalog exploration.{" "}
              <b>Lineage</b> takes a dataset and explains what feeds it, what it breaks, and who to
              warn. <b>Progress</b> tracks how far through the plan someone has got. Prefer a
              terminal? <code>npm run draft</code> writes runbooks from catalog evidence with
              nobody recording anything, and <code>npm run validate</code> sweeps every stored
              runbook and exits non-zero on a broken one, which is enough to hang off cron.
            </p>
          </div>
        </div>
      </section>

      <section className="band" id="extension">
        <div className="band-grid">
          <div className="band-rail">extension</div>
          <div>
            <h2 className="lp-h2">A side panel that rides along inside DataHub.</h2>
            <p className="lp-sub">
              The Chrome extension reads the URN of whatever DataHub page you have open and
              explains it right there, so you stay on the page. It runs as a thin client on the
              same agent, which keeps API keys out of the browser.
            </p>

            <div className="lp-ext lp-reveal" ref={extRef} aria-hidden="true">
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

            <p className="lp-note">
              Installing takes a minute. It ships in the repo&rsquo;s{" "}
              <a
                href="https://github.com/mcrowley19/Instaboard/tree/main/extension"
                target="_blank"
                rel="noreferrer"
              >
                extension/ folder
              </a>
              . Open <code>chrome://extensions</code>, turn on Developer mode, and hit{" "}
              <b>Load unpacked</b>. There is no store listing involved and no API key goes into
              the browser.
            </p>

            <p className="lp-note">
              Everything the panel does also lives in the web app, alongside a week-one learning
              path and a ramp checklist generated from the catalog.
            </p>
          </div>
        </div>
      </section>

      <section className="band" id="handoffs">
        <div className="band-grid">
          <div className="band-rail">handoffs</div>
          <div>
            <h2 className="lp-h2">Someone leaving can record what they know by doing it.</h2>
            <p className="lp-sub">
              Writing it down is a separate job nobody has time for, so the recording rides
              along with the work itself.
            </p>

            <div className="lp-ruler" ref={rulerRef}>
              <div className="lp-phases">
                {PHASES.map((p) => (
                  <div className="lp-phase" key={p.title}>
                    <div className="tickmark" />
                    <h3>
                      <span className="who">{p.who}</span>
                      {p.title}
                    </h3>
                    <p>{p.body}</p>
                  </div>
                ))}
              </div>
            </div>

            <p className="lp-note">
              The finished runbook is saved back into DataHub through <code>save_document</code> and
              linked to the datasets it touches.
            </p>
          </div>
        </div>
      </section>

      <section className="band" id="decay">
        <div className="band-grid">
          <div className="band-rail">validating</div>
          <div>
            <h2 className="lp-h2">Runbooks rot, and the catalog is what notices.</h2>
            <p className="lp-sub">
              Six months on, the column has been renamed, the table is deprecated, an assertion
              is failing and the owner has moved on, while the runbook reads exactly as
              confidently as it did the day it was written. So instaboard re-checks every step
              against live DataHub with a schema diff and a health read. No LLM goes near it, and
              you can confirm any verdict in the DataHub UI in ten seconds.
            </p>

            <div className="lp-reveal" ref={decayRef}>
              <DriftPlayground />
            </div>

            {/* Renders only where the deployment has a DataHub it is allowed to
                write to. Everywhere else it is absent rather than disabled. */}
            <WriteBackPlayground />

            <p className="lp-note">
              It diffs the catalog facts each step depended on at record time against the
              catalog now, so it catches vanished columns the step&rsquo;s SQL references, tables
              deprecated since, newly failing assertions, and owners who no longer own the thing.
              Against a real DataHub that same result gets written back as a note, a failing
              assertion, structured properties and an incident assigned to whoever owns the table
              today.
            </p>
          </div>
        </div>
      </section>

      <section className="band" id="proof">
        <div className="band-grid">
          <div className="band-rail">measured</div>
          <div>
            <h2 className="lp-h2">Does the catalog help? We measured it.</h2>
            <p className="lp-sub">
              Twenty questions a new hire asks in week one, scored deterministically against the
              catalog on table names, owners and URNs, with no LLM judge anywhere in the scoring.
              The same agent runs both arms, and the one thing that changes between them is
              whether the DataHub MCP tools are in the tool list.
            </p>

            <div className="lp-bench" ref={benchRef}>
              {BENCH.map((arm) => (
                <div className={`lp-arm ${arm.kind}`} key={arm.label}>
                  <div className="lp-arm-head">
                    <b>{arm.label}</b>
                    <span className="key">{arm.sub}</span>
                  </div>
                  <div className="lp-arm-dots" role="img" aria-label={`${arm.score} of 20 cases passed`}>
                    {Array.from({ length: 20 }, (_, i) => (
                      <span
                        key={i}
                        className={i < arm.score ? "on" : ""}
                        style={{ transitionDelay: `${0.2 + i * 0.045}s` }}
                      />
                    ))}
                  </div>
                  <div className="lp-arm-score">
                    {arm.score}
                    <span>/20</span>
                  </div>
                </div>
              ))}
            </div>

            <p className="lp-note">
              A case passes only when every check in it passes. Asked about a table that
              doesn&rsquo;t exist, the grounded agent says so, while the control invents a schema.
              Every raw answer is committed, so anyone can audit a check by hand.{" "}
              <a
                href="https://github.com/mcrowley19/Instaboard/blob/main/evals/results/scorecard.md"
                target="_blank"
                rel="noreferrer"
              >
                Read the scorecard
              </a>{" "}
              or run it yourself: <code>DEMO_MODE=true npm run eval</code>.
            </p>
          </div>
        </div>
      </section>

      <section className="band lp-install" id="start">
        <div className="band-grid">
          <div className="band-rail">install</div>
          <div>
            <h2 className="lp-h2">Running in about a minute.</h2>
            <p className="lp-sub">
              Demo mode answers every catalog call from a built-in fixture of Northbeam, a
              subscription-commerce warehouse with 14 datasets, four owners and real lineage.
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

            <p className="lp-note">
              Pointing it at a live catalog takes two more commands,{" "}
              <code>npm run datahub:up</code> and <code>npm run seed</code>, covered in the README.
            </p>
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
