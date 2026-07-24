"use client";

import { useEffect, useState } from "react";
import type { Handoff } from "@/lib/types";

const PROGRESS_KEY = "instaboard.handoff-progress";

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
