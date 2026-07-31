"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import "./landing.css";

/* ── content ──────────────────────────────────────────────────────────── */

const STEPS = [
  { call: "search", arg: 'query: "events"', ret: "2 datasets across postgres + snowflake" },
  { call: "get_entities", arg: "postgres,northbeam.public.events", ret: "owned by James Okafor and Sarah Chen · domain Growth" },
  { call: "get_dataset_health", arg: "same urn", ret: "deprecated 2025-11-01 → analytics.marts.events_sessionized" },
  { call: "get_usage_stats", arg: "window: 30d", ret: "74 queries, trending down" },
];

const ASKS: [string, string, string][] = [
  ["What tables do we use for revenue?", "search → get_entities", "fct_revenue and mrr_monthly, with the owner and a URN you can paste straight into DataHub"],
  ["What breaks if I change users.email?", "get_lineage", "the downstream marts that would go red, and the people to warn before you ship"],
  ["Show me SQL for churn analysis", "get_dataset_queries", "the saved query someone already wrote against fct_churn"],
  ["Which Payments tables matter first?", "get_usage_stats", "an order based on what people query, not what happens to sit in the domain"],
  ["Is this table safe to build on?", "get_dataset_health", "deprecation status, open incidents, and any freshness assertion that has been failing"],
  ["Why is there no description here?", "save_document", "a proposal drafted from the schema and lineage it just read, filed for an owner to approve"],
];

const PHASES = [
  { who: "leaving", title: "Record", body: "Open the side panel, press record, then do the task the way you always do it. Every DataHub page you land on becomes a step." },
  { who: "leaving", title: "Annotate", body: "Type the why next to each step — the reason one column gets filtered out before any of the numbers make sense." },
  { who: "instaboard", title: "Enrich", body: "The agent walks the catalog for every step and attaches owners, saved SQL, upstream lineage and tags." },
  { who: "joining", title: "Inherit", body: "Whoever picks the task up replays it in the same panel, and the step lights up when their browser is on the page it describes." },
];

const DRIFT_CHECKS = [
  ["entity removed", "The dataset a step points at is no longer in the catalog."],
  ["column gone", "A column the step's SQL actually references has disappeared from the schema."],
  ["newly deprecated", "The table was fine when the runbook was written and has since been retired."],
  ["assertion failing", "A freshness or volume check on the table started failing after the fact."],
  ["owner moved on", "The step says to ping someone who no longer owns the dataset."],
];

export interface BenchmarkSummary {
  model: string;
  at: string;
  total: number;
  grounded: number;
  blind: number;
  toolCalls: number;
  categories: { name: string; grounded: number; blind: number; total: number }[];
}

/* ── reveal ───────────────────────────────────────────────────────────── */

function useReveal<T extends HTMLElement>(rootMargin = "0px 0px -60px 0px") {
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
      { threshold: 0.1, rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return ref;
}

function Arrow() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2 8h11M9 4l4 4-4 4" />
    </svg>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function Landing({ benchmark }: { benchmark: BenchmarkSummary | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const [played, setPlayed] = useState(0);

  const figuresRef = useReveal<HTMLDivElement>();
  const barsRef = useReveal<HTMLDivElement>();
  const indexRef = useReveal<HTMLDivElement>();
  const phasesRef = useReveal<HTMLDivElement>();
  const decayRef = useReveal<HTMLDivElement>();
  const surfacesRef = useReveal<HTMLDivElement>();
  const heroRef = useRef<HTMLElement>(null);

  // Hero reveals on load; everything else on scroll.
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      rootRef.current?.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
      setPlayed(STEPS.length + 1);
      return;
    }
    rootRef.current?.classList.add("anim");
    const raf = requestAnimationFrame(() => {
      heroRef.current?.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Step the transcript once, when it scrolls into view.
  useEffect(() => {
    const el = traceRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
        }, 640);
      },
      { rootMargin: "0px 0px -25% 0px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearInterval(timer);
    };
  }, []);

  const delta = benchmark ? benchmark.grounded - benchmark.blind : 0;

  return (
    <div className="lp" ref={rootRef}>
      <header className="lp-bar">
        <div className="lp-mark">
          <i>i</i> instaboard
        </div>
        <nav className="lp-nav">
          {benchmark && (
            <a href="#measured" className="hide-sm">
              measured
            </a>
          )}
          <a href="#handoffs" className="hide-sm">
            handoffs
          </a>
          <a href="#decay" className="hide-sm">
            decay
          </a>
          <a href="#start">install</a>
          <Link className="go" href="/chat">
            open the app
          </Link>
        </nav>
      </header>

      {/* ── hero ── */}
      <section className="lp-hero" ref={heroRef}>
        <div className="wrap">
          <div className="lp-hero-meta reveal" style={{ ["--i" as string]: 0 }}>
            <span className="field">onboarding &amp; handover for data teams</span>
            <span className="field">reads: datahub · via: mcp</span>
          </div>

          <h1 className="reveal" style={{ ["--i" as string]: 1 }}>
            The person who built your pipeline left <em>in March.</em>
          </h1>

          <div className="lp-hero-body">
            <div>
              <p className="lede reveal" style={{ ["--i" as string]: 2 }}>
                Their replacement inherits a catalog, not an explanation. instaboard records how
                the work actually gets done, writes it back into DataHub as a runbook the next
                person can follow — and keeps checking whether it is still true.
              </p>
              <div className="lp-acts reveal" style={{ ["--i" as string]: 3 }}>
                <Link className="btn-primary" href="/chat">
                  Ask it something <Arrow />
                </Link>
                <a className="btn-ghost" href="#start">
                  Run it locally
                </a>
              </div>
            </div>

            <div className="lp-card reveal" style={{ ["--i" as string]: 4 }}>
              <div className="lp-card-head">
                <span className="field field-ink">personnel file</span>
                <span className="lp-stamp">departed</span>
              </div>
              <div className="lp-card-rows">
                <div className="lp-card-row">
                  <span className="field">name</span>
                  <span className="v">Priya Patel</span>
                </div>
                <div className="lp-card-row">
                  <span className="field">role</span>
                  <span className="v">Payments Data Lead</span>
                </div>
                <div className="lp-card-row">
                  <span className="field">owned</span>
                  <span className="v">fct_revenue · mrr_monthly · payment_health_daily</span>
                </div>
                <div className="lp-card-row">
                  <span className="field">knew</span>
                  <span className="v">why the board deck uses net_amount_usd and never gross</span>
                </div>
                <div className="lp-card-row">
                  <span className="field">wrote down</span>
                  <span className="v">nothing</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── measurement — only rendered when a real run exists ── */}
      {benchmark && (
        <section id="measured">
          <div className="wrap split">
            <div className="margin-note">
              <span className="ref">01 / measured</span>
              <p>
                Deterministic scoring. No LLM judge. Both arms run the same agent loop — only the
                DataHub tools differ.
              </p>
            </div>
            <div>
              <h2>We measured whether the catalog actually helps.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                {benchmark.total} questions a new hire asks in week one, scored against facts that
                live in DataHub — real URNs, real owners, real columns. The same cases run twice:
                once with the MCP tools, once with the tool list emptied.
              </p>

              <div className="lp-figures reveal" ref={figuresRef}>
                <div className="lp-figure hot">
                  <span className="n">
                    {benchmark.grounded}
                    <small>/{benchmark.total}</small>
                  </span>
                  <p>Passed with DataHub grounding.</p>
                </div>
                <div className="lp-figure">
                  <span className="n">
                    {benchmark.blind}
                    <small>/{benchmark.total}</small>
                  </span>
                  <p>Passed without it — the same agent, no catalog.</p>
                </div>
                <div className="lp-figure">
                  <span className="n">+{delta}</span>
                  <p>Questions that are only answerable from the catalog.</p>
                </div>
              </div>

              <div className="lp-bars reveal" ref={barsRef}>
                {benchmark.categories.map((c) => (
                  <div className="lp-bar-row" key={c.name}>
                    <span className="field field-ink">{c.name}</span>
                    <span className="lp-bar-track">
                      <span
                        className="lp-bar-fill blind"
                        style={{ ["--w" as string]: `${(c.blind / c.total) * 100}%`, height: 3, top: 4 }}
                      />
                      <span
                        className="lp-bar-fill"
                        style={{ ["--w" as string]: `${(c.grounded / c.total) * 100}%`, height: 3 }}
                      />
                    </span>
                    <span className="n">
                      {c.grounded}/{c.total}
                    </span>
                  </div>
                ))}
              </div>

              <div className="lp-legend">
                <span>
                  <i /> with datahub
                </span>
                <span>
                  <i className="blind" /> without
                </span>
              </div>

              <p className="lede" style={{ marginTop: 22, fontSize: "0.92rem" }}>
                Run on <code>{benchmark.model}</code> · {benchmark.at} · {benchmark.toolCalls} MCP
                calls. Reproduce it yourself with <code>npm run eval</code> — every raw answer is
                committed so any check can be audited by hand.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── transcript ── */}
      <section id="answers">
        <div className="wrap split-offset">
          <div className="margin-note">
            <span className="ref">{benchmark ? "02" : "01"} / grounded</span>
            <p>The agent is handed the live MCP tool list and picks what it needs mid-answer.</p>
          </div>
          <div>
            <h2>It answers off the catalog you already run.</h2>

            <div className="lp-trace" ref={traceRef}>
              <div className="lp-trace-head">
                <span className="field field-ink">agent transcript</span>
                <span className="field grow">northbeam · demo catalog</span>
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
                  That table was deprecated on 2025-11-01 and is kept only for pipeline debugging.
                  Build on <code>events_sessionized</code> instead — the sessionized mart James
                  Okafor owns. Volume on the raw firehose has been sliding all quarter.
                  <span className="cite">
                    urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.events_sessionized,PROD)
                  </span>
                </p>
              </div>
            </div>

            <div className="lp-index reveal" ref={indexRef}>
              {ASKS.map(([ask, calls, back], i) => (
                <div className="lp-row" key={ask}>
                  <span className="num">{String(i + 1).padStart(2, "0")}</span>
                  <span className="ask">{ask}</span>
                  <span className="calls">{calls}</span>
                  <span className="back">{back}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── handoffs ── */}
      <section id="handoffs">
        <div className="wrap split">
          <div className="margin-note">
            <span className="ref">{benchmark ? "03" : "02"} / handover</span>
            <p>Writing it down is a separate job nobody has time for. So the recording happens while the work happens.</p>
          </div>
          <div>
            <h2>Someone leaving can record what they know by doing it.</h2>
            <p className="lede" style={{ marginTop: 18 }}>
              The finished runbook is saved back into DataHub through <code>save_document</code>,
              linked to the datasets it touches, so the next person finds it in the catalog rather
              than in somebody&rsquo;s outbox.
            </p>

            <div className="lp-phases reveal" ref={phasesRef}>
              {PHASES.map((p) => (
                <div className="lp-phase" key={p.title}>
                  <span className="who">{p.who}</span>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── decay ── */}
      <section id="decay" className="lp-decay">
        <div className="wrap split-offset">
          <div className="margin-note">
            <span className="ref">{benchmark ? "04" : "03"} / decay</span>
            <p>A schema diff and a health read. No model involved, so every verdict is checkable by hand.</p>
          </div>
          <div>
            <h2>A runbook nobody re-checks is worse than none.</h2>
            <p className="lede" style={{ marginTop: 18 }}>
              Captured knowledge rots. instaboard snapshots the catalog facts each step depends on
              when it is written, then re-reads them against live DataHub on demand — and writes
              what drifted back into the catalog.
            </p>

            <div className="lp-decay-demo reveal" ref={decayRef}>
              <div className="lp-runbook">
                <div className="lp-runbook-stamp">
                  <span className="lp-stamp">stale</span>
                </div>
                <div className="lp-runbook-step flagged">
                  <span className="st">step 01 · flagged</span>
                  Check payment pipeline health before reporting anything.
                  <span className="lp-finding">
                    <strong>failing-assertion</strong> — payment_health_daily has 1 failing
                    freshness assertion (was 0 when recorded).
                  </span>
                </div>
                <div className="lp-runbook-step">
                  <span className="st">step 02 · ok</span>
                  Verify fct_revenue loaded cleanly; use net_amount_usd, never gross.
                </div>
                <div className="lp-runbook-step">
                  <span className="st">step 03 · ok</span>
                  Pull the MRR rollup for the board template.
                </div>
              </div>

              <div>
                <div className="lp-checks">
                  {DRIFT_CHECKS.map(([label, body]) => (
                    <div className="lp-check" key={label}>
                      <span className="mk">✕</span>
                      <span>
                        <span className="lbl">{label}</span>
                        <p>{body}</p>
                      </span>
                    </div>
                  ))}
                </div>
                <p className="lede" style={{ marginTop: 18, fontSize: "0.92rem" }}>
                  Priya wrote that runbook on 1 July. The freshness check on step one started
                  failing on the 29th. Nobody would have known until the board numbers were wrong.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── surfaces ── */}
      <section>
        <div className="wrap split">
          <div className="margin-note">
            <span className="ref">{benchmark ? "05" : "04"} / surfaces</span>
            <p>One backend, two places it turns up.</p>
          </div>
          <div>
            <h2>The same agent, wherever the work is.</h2>
            <div className="lp-surfaces reveal" ref={surfacesRef}>
              <div className="lp-surface">
                <span className="field">localhost:3000</span>
                <h3>Web app</h3>
                <p>
                  Chat with the tool trace open, a week-one learning path generated from live
                  catalog exploration, a lineage explainer that tells you what breaks, and the
                  handoff library with one-click validation.
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
                <span className="field">extension/</span>
                <h3>Chrome side panel</h3>
                <p>
                  It rides along inside DataHub, reads the URN of whatever page you have open, and
                  explains it there. Thin client — no keys ever go in the extension.
                </p>
                <div className="lp-chips">
                  <span>explain this table</span>
                  <span>who owns it</span>
                  <span>record a handoff</span>
                  <span>replay a handoff</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── install ── */}
      <section id="start">
        <div className="wrap split">
          <div className="margin-note">
            <span className="ref">{benchmark ? "06" : "05"} / install</span>
            <p>Docker can wait until the second pass.</p>
          </div>
          <div>
            <h2>Running in about a minute.</h2>
            <p className="lede" style={{ marginTop: 18 }}>
              Demo mode answers every catalog call from a built-in fixture of Northbeam — a
              subscription-commerce warehouse with 14 datasets, four owners, a metrics glossary and
              real lineage. The benchmark runs against it too, on a free API key.
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

            <p className="lede">
              Pointing it at a live catalog takes two more commands —{" "}
              <code>npm run datahub:up</code> and <code>npm run seed</code> — both written up in the{" "}
              <a
                className="tlink"
                href="https://github.com/acryldata/mcp-server-datahub"
                target="_blank"
                rel="noreferrer"
              >
                DataHub MCP server
              </a>{" "}
              docs and the README.
            </p>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <span>instaboard v0.1.0</span>
        <a className="tlink" href="https://docs.datahub.com/docs/quickstart" target="_blank" rel="noreferrer">
          datahub quickstart
        </a>
        <a className="tlink" href="https://github.com/acryldata/mcp-server-datahub" target="_blank" rel="noreferrer">
          mcp-server-datahub
        </a>
        <Link className="push tlink" href="/chat">
          open the app ↗
        </Link>
      </footer>
    </div>
  );
}
