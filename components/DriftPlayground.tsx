"use client";

/**
 * Break the catalog and watch the runbook notice.
 *
 * The claim this project rests on is that a captured workflow can tell you when
 * it has stopped being true. A page that asserts that is a page a reader has to
 * believe; a page that lets them do it is one they can test. So the buttons make
 * real changes to a fixture catalog, and the verdict comes back from the same
 * detection function the live sweep runs — no scripted response, no branch in
 * the engine for the demo.
 *
 * It is still a fixture where no catalog is configured, and the panel says so.
 * What *this* panel cannot show is the write-back: incidents, assertions and
 * tags change the catalog, and being read-only is what makes this one safe to
 * leave running in public. `WriteBackPlayground` is the half that writes, and it
 * renders only where the deployment has a catalog it is allowed to break.
 */

import { useCallback, useEffect, useState } from "react";

interface Mutation {
  id: string;
  label: string;
  detail: string;
  affectsStep: number;
}

interface Finding {
  stepIndex: number;
  stepTitle: string;
  severity: "ok" | "warning" | "broken";
  kind: string;
  detail: string;
  remedy?: string;
}

interface StepCoverage {
  stepIndex: number;
  stepTitle: string;
  state: "validated" | "partial" | "unvalidatable";
  gaps: string[];
  detail: string;
}

interface Result {
  verdict?: "PASS" | "FINDING" | "INSUFFICIENT_DATA";
  severity: "ok" | "warning" | "broken";
  findings: Finding[];
  coverage?: {
    summary: string;
    claimsTotal: number;
    claimsChecked: number;
    claimsUnvalidatable: number;
    steps: StepCoverage[];
  };
  claims?: { id: string }[];
  verdicts?: { claimId: string; status: string }[];
  steps: { title: string; urn?: string }[];
  checkedAt: string;
  /** False when the datasets below were read out of a real DataHub for this request. */
  fixture?: boolean;
  live?: {
    gms: string;
    datahubVersion?: string;
    readAt: string;
    readMs: number;
    cached: boolean;
    entities: { urn: string; exists: boolean; version?: string; fields: number; owners: number }[];
  };
}

const VERDICT_COPY: Record<string, { label: string; tone: string; blurb: string }> = {
  PASS: {
    label: "PASS",
    tone: "ok",
    blurb: "Every claim this runbook makes about the catalog was checked, and every one holds.",
  },
  FINDING: {
    label: "FINDING",
    tone: "bad",
    blurb: "The catalog moved under a step. Following the runbook as written would not work.",
  },
  INSUFFICIENT_DATA: {
    label: "INSUFFICIENT_DATA",
    tone: "warn",
    blurb:
      "Nothing drifted among the claims that could be checked — but the catalog could not answer for all of " +
      "them, so this is not a clean bill of health.",
  },
};

export default function DriftPlayground() {
  const [mutations, setMutations] = useState<Mutation[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const validate = useCallback(async (ids: string[]) => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/demo/drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutations: ids }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setResult((await res.json()) as Result);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  // Load the change list and the clean baseline together, so the first thing on
  // screen is the runbook validating green — the state the drift is measured from.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/demo/drift");
        const data = (await res.json()) as { mutations: Mutation[] };
        setMutations(data.mutations);
      } catch {
        setFailed(true);
      }
      await validate([]);
    })();
  }, [validate]);

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
    setSelected(next);
    void validate(next);
  };

  const reset = () => {
    setSelected([]);
    void validate([]);
  };

  const verdict = result?.verdict ? VERDICT_COPY[result.verdict] : null;
  const held = result?.verdicts?.filter((v) => v.status === "holds").length ?? 0;
  const total = result?.verdicts?.length ?? 0;

  return (
    <div className="lp-play">
      <div className="lp-play-controls">
        <div className="lp-play-label">
          Break the catalog. The runbook was recorded 2026-07-01 against a catalog where all of this was true.
        </div>
        <div className="lp-play-buttons">
          {mutations.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`lp-play-btn${selected.includes(m.id) ? " on" : ""}`}
              onClick={() => toggle(m.id)}
              aria-pressed={selected.includes(m.id)}
              title={m.detail}
            >
              {m.label}
            </button>
          ))}
          {selected.length > 0 && (
            <button type="button" className="lp-play-btn reset" onClick={reset}>
              Put it all back
            </button>
          )}
        </div>
      </div>

      <div className="lp-decay">
        <div className="lp-trace-head">
          <span className={`dot ${result?.severity === "ok" ? "" : "warn"}`} />
          <span>runbook validation</span>
          <span className="grow">monthly MRR report · recorded 2026-07-01 by Priya Patel</span>
        </div>

        <div className="lp-decay-body">
          {failed && (
            <div className="lp-decay-row">
              <span className="lp-decay-badge">error</span>
              <div>The validation endpoint did not answer. Nothing is cached, so a reload will retry it.</div>
            </div>
          )}

          {verdict && (
            <div className="lp-decay-row">
              <span className="lp-decay-badge">verdict</span>
              <div>
                <b className={`lp-verdict ${verdict.tone}`}>{verdict.label}</b> — {verdict.blurb}
                <span className="lp-decay-remedy">
                  {held}/{total} catalog claims hold
                  {result?.coverage?.claimsUnvalidatable
                    ? `, ${result.coverage.claimsUnvalidatable} could not be checked`
                    : ""}{" "}
                  · {result?.coverage?.summary}
                </span>
              </div>
            </div>
          )}

          {result?.findings.map((f, i) => (
            <div key={i} className="lp-decay-row">
              <span className="lp-decay-badge">step {f.stepIndex + 1}</span>
              <div>
                <b className={f.severity === "broken" ? "lp-verdict bad" : undefined}>{f.kind}</b> — {f.detail}
                {f.remedy && <span className="lp-decay-remedy">{f.remedy}</span>}
              </div>
            </div>
          ))}

          {/* Claims-that-could-be-checked, not "everything": the gap rows below
              are the rest of the sentence, and overstating this one undoes them. */}
          {result && result.findings.length === 0 && (
            <div className="lp-decay-row ok">
              <span className="lp-decay-badge">steps 1–3</span>
              <div>
                <b>checks out</b> —{" "}
                {result.coverage?.claimsUnvalidatable
                  ? `${result.coverage.claimsChecked} of ${result.coverage.claimsTotal} claims were checkable, and every one of those still holds.`
                  : "every schema, owner and health fact the recording captured still matches."}
              </div>
            </div>
          )}

          {/* The distinction the verdict exists for. A step nothing is monitoring
              is not a step that passed. */}
          {result?.coverage?.steps
            .filter((s) => s.gaps.length > 0)
            .map((s) => (
              <div key={s.stepIndex} className="lp-decay-row gap">
                <span className="lp-decay-badge">step {s.stepIndex + 1}</span>
                <div>
                  <b>not checkable</b> — {s.detail}
                  <span className="lp-decay-remedy">
                    Reported as a catalog gap rather than counted as clean. Adding the missing metadata makes it
                    checkable.
                  </span>
                </div>
              </div>
            ))}
        </div>

        <div className="lp-decay-foot">
          <span className="tick">●</span>
          {busy
            ? "re-validating…"
            : "detection is a schema and health diff against what the recording captured — no LLM in it"}
          <span className="grow">diffAgainstCatalog</span>
        </div>
      </div>

      {/*
        Where the numbers above came from, stated rather than implied. A reader
        who cannot tell a live read from a replay has no reason to believe
        either, so the live variant prints the catalog, its version, when it was
        read and the fingerprints that came back — all recomputable from the
        catalog's own facts.
      */}
      {result?.live ? (
        <p className="lp-note">
          Read from a live DataHub at <code>{result.live.gms}</code>
          {result.live.datahubVersion ? ` (${result.live.datahubVersion})` : ""} at{" "}
          {new Date(result.live.readAt).toISOString().replace("T", " ").slice(0, 19)} UTC
          {result.live.cached ? ", shared with another visitor in the last few seconds" : ` in ${result.live.readMs}ms`}
          . Fingerprints computed from what it returned:{" "}
          {result.live.entities.map((e) => `${e.urn.split(",")[1]?.split(".").pop()}@${e.version ?? "—"}`).join(", ")}.
          Your changes were applied to that read and thrown away — <em>this panel</em> writes nothing, so nobody
          driving it can damage the catalog, and you are not seeing anyone else&apos;s changes. Write-back is the
          other half: it is the panel below where this deployment has a catalog it is allowed to break, and{" "}
          <a href="https://github.com/mcrowley19/Instaboard/blob/main/.github/workflows/prove.yml">CI</a> re-derives
          it from nothing on every push.
        </p>
      ) : (
        <p className="lp-note">
          This runs against a built-in fixture of the Northbeam catalog, so nothing is written back — incidents,
          assertions and tags need a real DataHub. The verdict above comes from the same function the live sweep
          calls. Receipts from real runs, including a stale tag being applied and then retracted when the runbook is
          repaired, are committed at{" "}
          <a href="https://github.com/mcrowley19/Instaboard/blob/main/examples/live/prove-loop-receipts.json">
            examples/live/
          </a>
          .
        </p>
      )}
    </div>
  );
}
