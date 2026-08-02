"use client";

import { useEffect, useState } from "react";
import type { DecayReport, Handoff } from "@/lib/types";

const PROGRESS_KEY = "instaboard.handoff-progress";

const SEVERITY_STYLE: Record<DecayReport["severity"], { color: string; icon: string; label: string }> = {
  ok: { color: "var(--green)", icon: "✅", label: "Still accurate" },
  warning: { color: "var(--amber, #b7791f)", icon: "⚠️", label: "Needs attention" },
  broken: { color: "var(--red)", icon: "🛑", label: "Out of date" },
};

function loadProgress(): Record<string, Record<number, boolean>> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
  } catch {
    return {};
  }
}

export default function HandoffsPage() {
  const [handoffs, setHandoffs] = useState<Handoff[] | null>(null);
  const [selected, setSelected] = useState<Handoff | null>(null);
  const [progress, setProgress] = useState<Record<string, Record<number, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [writtenBack, setWrittenBack] = useState(false);
  // "18 of 19 claims still hold" is a more useful verdict than "stale": it says
  // the runbook is followable apart from one named thing.
  const [claims, setClaims] = useState<{ total: number; holds: number } | null>(null);
  const [proposedEdits, setProposedEdits] = useState(0);

  const validate = async (id: string) => {
    setValidating(true);
    setWrittenBack(false);
    setClaims(null);
    setProposedEdits(0);
    try {
      const res = await fetch(`/api/handoffs/${id}/verify`, { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setWrittenBack(Boolean(data.writtenBack));
      setClaims(data.claims ?? null);
      setProposedEdits(data.proposal?.edits?.length ?? 0);
      const report = data.report as DecayReport;
      setSelected((prev) => (prev && prev.id === id ? { ...prev, decay: report } : prev));
      setHandoffs((prev) => prev?.map((h) => (h.id === id ? { ...h, decay: report } : h)) ?? prev);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  };

  useEffect(() => {
    setProgress(loadProgress());
    fetch("/api/handoffs")
      .then((r) => r.json())
      .then((d) => setHandoffs(d.handoffs ?? []))
      .catch((e) => setError(String(e)));
  }, []);

  const toggle = (handoffId: string, step: number) => {
    setProgress((prev) => {
      const mine = { ...(prev[handoffId] ?? {}) };
      mine[step] = !mine[step];
      const next = { ...prev, [handoffId]: mine };
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const remove = async (id: string) => {
    await fetch(`/api/handoffs/${id}`, { method: "DELETE" });
    setSelected(null);
    setHandoffs((prev) => (prev ? prev.filter((h) => h.id !== id) : prev));
  };

  if (selected) {
    const mine = progress[selected.id] ?? {};
    const done = selected.steps.filter((_, i) => mine[i]).length;
    const pct = selected.steps.length ? Math.round((done / selected.steps.length) * 100) : 0;

    return (
      <div className="page">
        <div className="page-narrow">
          <button className="btn btn-ghost" onClick={() => setSelected(null)}>← All handoffs</button>
          <h1 className="page-title" style={{ marginTop: 12 }}>{selected.title}</h1>
          <p className="page-sub" style={{ marginBottom: 12 }}>
            Recorded by <strong>{selected.author}</strong>
            {selected.role ? ` · ${selected.role}` : ""} · {selected.createdAt.slice(0, 10)}
            {selected.sample && <span className="tag warn" style={{ marginLeft: 8 }}>sample</span>}
            {selected.datahub?.saved && <span className="tag" style={{ marginLeft: 8 }}>✓ in DataHub</span>}
          </p>
          <div className="card" style={{ marginBottom: 16 }}>
            <p style={{ color: "var(--text-dim)" }}>{selected.summary}</p>
          </div>

          {/* Knowledge decay: a runbook is only as good as the catalog it assumed. */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => validate(selected.id)} disabled={validating}>
                {validating ? "Checking DataHub…" : "Validate against DataHub"}
              </button>
              <span className="check-detail" style={{ margin: 0 }}>
                Re-reads every entity this runbook depends on and reports what has drifted since{" "}
                {selected.createdAt.slice(0, 10)}.
              </span>
            </div>

            {selected.decay && (
              <div style={{ marginTop: 14 }}>
                <div
                  style={{
                    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                    fontWeight: 650, color: SEVERITY_STYLE[selected.decay.severity].color,
                  }}
                >
                  <span>{SEVERITY_STYLE[selected.decay.severity].icon}</span>
                  <span>{SEVERITY_STYLE[selected.decay.severity].label}</span>
                  <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>
                    · {selected.decay.stepsChecked} steps · {selected.decay.entitiesChecked} entities
                    {selected.decay.findings.length > 0 && ` · ${selected.decay.findings.length} finding${
                      selected.decay.findings.length === 1 ? "" : "s"
                    }`}
                  </span>
                  {claims && claims.total > 0 && (
                    <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>
                      · {claims.holds}/{claims.total} catalog claims still hold
                    </span>
                  )}
                  {writtenBack && <span className="tag">✓ flagged in DataHub</span>}
                  {proposedEdits > 0 && (
                    <span className="tag">
                      ✎ {proposedEdits} correction{proposedEdits === 1 ? "" : "s"} proposed
                    </span>
                  )}
                </div>

                {!selected.decay.hadSnapshot && (
                  <p className="check-detail" style={{ marginTop: 6 }}>
                    No baseline was recorded for this runbook, so only current-state checks ran
                    (deprecation, incidents, assertions, owners) — not schema drift.
                  </p>
                )}

                {selected.decay.findings.length === 0 && (
                  <p className="check-detail" style={{ marginTop: 6 }}>
                    Every table, column, and owner this runbook relies on still checks out.
                  </p>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
            <div className="col-label" style={{ margin: 0 }}>
              {done}/{selected.steps.length} steps done ({pct}%)
            </div>
          </div>
          <div className="progress-bar">
            <div style={{ width: `${pct}%` }} />
          </div>

          {selected.steps.map((step, i) => (
            <div key={i} className="card day-card">
              <label className={`check-item ${mine[i] ? "done" : ""}`} style={{ padding: 0 }}>
                <input type="checkbox" checked={Boolean(mine[i])} onChange={() => toggle(selected.id, i)} />
                <div className="ct">
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="day-num" style={{ width: 24, height: 24, fontSize: 12 }}>{i + 1}</span>
                    <span style={{ fontWeight: 650 }}>{step.title}</span>
                  </div>
                </div>
              </label>
              <div style={{ paddingLeft: 25, marginTop: 8 }}>
                {(selected.decay?.findings ?? [])
                  .filter((f) => f.stepIndex === i)
                  .map((f, k) => (
                    <div
                      key={k}
                      style={{
                        borderLeft: `3px solid ${SEVERITY_STYLE[f.severity].color}`,
                        background: "#fffaf2", borderRadius: 6,
                        padding: "8px 12px", marginBottom: 10, fontSize: 13,
                      }}
                    >
                      <strong style={{ color: SEVERITY_STYLE[f.severity].color }}>
                        {SEVERITY_STYLE[f.severity].icon} {f.kind}
                      </strong>{" "}
                      {f.detail}
                      {f.remedy && (
                        <div style={{ color: "var(--text-dim)", marginTop: 4 }}>{f.remedy}</div>
                      )}
                      {/* The provenance chain: which claim broke, what it was validated
                          against, and what that aspect reads now. Recomputable from the
                          catalog, which is what makes the verdict checkable. */}
                      {(() => {
                        const claim = selected.decay?.claims?.find((c) => c.id === f.claimId);
                        const pinned = claim?.validatedAgainst;
                        if (!pinned) return null;
                        const now = selected.decay?.versions?.[f.urn]?.aspects[pinned.aspect];
                        return (
                          <div
                            style={{
                              color: "var(--text-dim)", marginTop: 6,
                              fontFamily: "var(--mono)", fontSize: 11,
                            }}
                          >
                            validated {pinned.at.slice(0, 10)} against {pinned.aspect}@{pinned.aspectVersion} →
                            now {pinned.aspect}@{now ?? "unreadable"}
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                <p style={{ marginBottom: 8 }}>{step.instruction}</p>
                <p className="check-detail" style={{ marginBottom: 8 }}>
                  <strong>Why:</strong> {step.why}
                </p>
                {step.sql && (
                  <pre
                    style={{
                      background: "#f4f8fb", border: "1px solid var(--border)", borderRadius: 8,
                      padding: "10px 12px", fontFamily: "var(--mono)", fontSize: 12,
                      overflowX: "auto", marginBottom: 8, whiteSpace: "pre-wrap",
                    }}
                  >
                    {step.sql}
                  </pre>
                )}
                {step.tips && (
                  <p className="check-detail" style={{ marginBottom: 8 }}>
                    <strong>Tips:</strong> {step.tips}
                  </p>
                )}
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  {step.url && (
                    <a className="btn" href={step.url} target="_blank" rel="noopener noreferrer">
                      Open in DataHub ↗
                    </a>
                  )}
                  {step.urn && <span className="urn">{step.urn}</span>}
                </div>
              </div>
            </div>
          ))}

          {pct === 100 && (
            <div className="card" style={{ textAlign: "center", borderColor: "var(--green)", marginBottom: 16 }}>
              🎉 Handoff complete — this task is yours now.
            </div>
          )}

          {!selected.sample && (
            <button className="btn btn-ghost" style={{ color: "var(--red)" }} onClick={() => remove(selected.id)}>
              Delete this handoff
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-narrow">
        <h1 className="page-title">Handoffs</h1>
        <p className="page-sub">
          Workflows recorded by people leaving, replayable by the people inheriting them. Record one
          from the instaboard side panel while you work in DataHub — the AI turns your trail and
          notes into a runbook, grounded in live catalog metadata, and saves it back to DataHub.
        </p>

        {error && <div className="error-banner">{error}</div>}

        {handoffs === null ? (
          <div className="thinking"><span /><span /><span /></div>
        ) : handoffs.length === 0 ? (
          <div className="card">No handoffs yet. Open the extension beside DataHub and hit ● Record.</div>
        ) : (
          handoffs.map((h) => {
            const mine = progress[h.id] ?? {};
            const done = h.steps.filter((_, i) => mine[i]).length;
            return (
              <div key={h.id} className="result-item" onClick={() => setSelected(h)}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 650 }}>{h.title}</span>
                  {h.sample && <span className="tag warn">sample</span>}
                  {h.datahub?.saved && <span className="tag">✓ in DataHub</span>}
                  {h.decay && h.decay.severity !== "ok" && (
                    <span className="tag warn">
                      {SEVERITY_STYLE[h.decay.severity].icon} {h.decay.findings.length} drifted
                    </span>
                  )}
                </div>
                <div className="check-detail" style={{ marginTop: 4 }}>
                  {h.author}{h.role ? ` · ${h.role}` : ""} · {h.steps.length} steps
                  {done > 0 && ` · ${done}/${h.steps.length} done`}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
