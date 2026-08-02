"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import "./landing.css";

const STEPS = [
  { call: "search", arg: 'query: "events"', ret: "2 datasets across postgres + snowflake" },
  { call: "get_entities", arg: "postgres,northbeam_app.public.events", ret: "owned by James Okafor and Sarah Chen · domain Growth" },
  { call: "get_dataset_health", arg: "same urn", ret: "deprecated 2025-11-01 → analytics.marts.events_sessionized" },
  { call: "get_usage_stats", arg: "window: 30d", ret: "74 queries, trending down" },
];

const CAPABILITIES: [string, string, string][] = [
  ["What tables do we use for revenue?", "search → get_entities", "fct_revenue and mrr_monthly, with the owner and a URN you can paste straight into DataHub"],
  ["How do we calculate MRR?", "get_entities", "the glossary definition, plus the terms sitting next to it like ARR and Churn Rate"],
  ["What breaks if I change users.email?", "get_lineage", "the downstream marts that would go red, and the people to warn before you ship"],
  ["Show me SQL for churn analysis", "get_dataset_queries", "the saved query someone already wrote against fct_churn"],
  ["Which Payments tables should I learn first?", "get_usage_stats", "an order based on what people query, rather than what happens to sit in the domain"],
  ["Is this table safe to build a report on?", "get_dataset_health", "deprecation status, open incidents, and any freshness assertion that has been failing"],
  ["Why is there no description here?", "save_document", "a proposal drafted from the schema and lineage it just read, filed for an owner to approve"],
];

const PHASES = [
  {
    who: "leaving",
    title: "Record",
    body: "Open the side panel, press record, then do the task the way you always do it. Every DataHub page you land on is captured as a step.",
  },
  {
    who: "leaving",
    title: "Annotate",
    body: "Type the why next to each step, like the reason one column gets filtered out before any of the numbers make sense.",
  },
  {
    who: "instaboard",
    title: "Enrich",
    body: "The agent walks the catalog for every step it was handed and attaches owners, saved SQL, upstream lineage and tags.",
  },
  {
    who: "joining",
    title: "Inherit",
    body: "Whoever picks the task up replays it in the same panel, and the step lights up when their browser is on the page it describes.",
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
  const rulerRef = useReveal<HTMLDivElement>();
  const surfacesRef = useReveal<HTMLDivElement>();

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
          <a href="#handoffs" className="hide-sm">
            handoffs
          </a>
          <a href="#start">install</a>
          <Link className="go" href="/chat">
            open the app
          </Link>
        </nav>
      </header>

      <section className="lp-head">
        <div className="lp-head-top">
          <span className="key">onboarding copilot for data teams</span>
          <span className="key">reads: datahub · via: mcp</span>
        </div>
        <div className="rule" />

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
                <em>in March.</em>
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
              <strong>instaboard</strong> reads your live DataHub catalog and answers the questions
              their replacement would have asked them, with real table names and the owner to go
              talk to.
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

      <section className="band" id="answers">
        <div className="band-grid">
          <div className="band-rail">answering</div>
          <div>
            <h2 className="lp-h2">It works off the catalog you already run.</h2>
            <p className="lp-sub">
              The agent is handed the live MCP tool list and picks what it needs mid-answer, so what
              comes back matches whatever landed in this morning&rsquo;s ingestion.
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

      <section className="band" id="handoffs">
        <div className="band-grid">
          <div className="band-rail">handoffs</div>
          <div>
            <h2 className="lp-h2">Someone leaving can record what they know by doing it.</h2>
            <p className="lp-sub">
              Writing it down is a separate job nobody has time for, so the recording happens while
              the work happens.
            </p>

            <div className="lp-ruler" ref={rulerRef}>
              <div className="lp-ruler-line" />
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

      <section className="band">
        <div className="band-grid">
          <div className="band-rail">surfaces</div>
          <div>
            <h2 className="lp-h2">The same agent turns up in two places.</h2>
            <div className="lp-surfaces lp-reveal" ref={surfacesRef}>
              <div className="lp-surface">
                <h3>Web app</h3>
                <span className="key">localhost:3000</span>
                <p>
                  Chat with the tool trace open, a week-one learning path generated from live
                  catalog exploration, a lineage explainer that tells you what breaks, and a
                  checklist you tick off as you ramp.
                </p>
                <div className="lp-chips">
                  <span>chat</span>
                  <span>learning path</span>
                  <span>lineage</span>
                  <span>handoffs</span>
                  <span>progress</span>
                </div>
              </div>
              <div className="lp-surface">
                <h3>Chrome side panel</h3>
                <span className="key">extension/</span>
                <p>
                  It rides along inside DataHub, reads the URN of whatever page you have open, and
                  explains it there. Thin client, so no keys ever go in the extension.
                </p>
                <div className="lp-chips">
                  <span>explain this table</span>
                  <span>who owns it</span>
                  <span>record a handoff</span>
                </div>
              </div>
            </div>
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
