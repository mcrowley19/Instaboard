"use client";

import { useEffect, useState } from "react";
import ToolTrace, { type TraceEntry } from "@/components/ToolTrace";
import { pathToMarkdown, savePath as persistPath, loadPath } from "@/lib/path-storage";
import { llmHeaders } from "@/lib/settings";
import { extractJsonBlock, streamAgent } from "@/lib/stream-client";
import type { LearningPath } from "@/lib/types";

export default function PathPage() {
  const [role, setRole] = useState("Junior Data Analyst");
  const [domain, setDomain] = useState("Payments");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [path, setPath] = useState<LearningPath | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [saveDetail, setSaveDetail] = useState("");

  useEffect(() => {
    setPath(loadPath());
  }, []);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setTraces([]);
    setSaveState("idle");
    let fullText = "";

    try {
      await streamAgent("/api/path", { role, domain }, llmHeaders(), (event) => {
        if (event.type === "text") {
          fullText += event.text + "\n";
        } else if (event.type === "tool_call") {
          setTraces((prev) => [...prev, { id: event.id, name: event.name, args: event.args, pending: true }]);
        } else if (event.type === "tool_result") {
          setTraces((prev) =>
            prev.map((t) =>
              t.id === event.id ? { ...t, result: event.result, isError: event.isError, pending: false } : t
            )
          );
        } else if (event.type === "error") {
          setError(event.message);
        }
      });

      const parsed = extractJsonBlock<LearningPath>(fullText);
      if (!parsed || !Array.isArray(parsed.days)) {
        setError("The agent did not return a valid plan. Try again — or check that DataHub is seeded (npm run seed).");
      } else {
        parsed.generatedAt = new Date().toISOString();
        setPath(parsed);
        persistPath(parsed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveToDataHub = async () => {
    if (!path) return;
    setSaveState("saving");
    try {
      const res = await fetch("/api/save-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Week 1 Onboarding — ${path.role} (${path.domain})`,
          content: pathToMarkdown(path),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "save_document failed");
      setSaveState("saved");
      setSaveDetail(typeof data.result === "string" ? data.result.slice(0, 300) : "");
    } catch (err) {
      setSaveState("failed");
      setSaveDetail(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <div className="page-narrow">
        <h1 className="page-title">Week 1 Learning Path</h1>
        <p className="page-sub">
          Generated live from your DataHub catalog — real tables, metrics, pipelines, and owners.
        </p>

        <div className="form-row">
          <div className="form-field">
            <label className="label">Role</label>
            <input className="input" value={role} onChange={(e) => setRole(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="label">Domain</label>
            <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="Payments, Growth…" />
          </div>
          <button className="btn btn-primary" onClick={generate} disabled={busy}>
            {busy ? "Exploring catalog…" : "Generate path"}
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {traces.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div className="col-label">Catalog exploration ({traces.length} DataHub calls)</div>
            {traces.map((t) => (
              <ToolTrace key={t.id} entry={t} />
            ))}
            {busy && (
              <div className="thinking" style={{ marginTop: 6 }}>
                <span /><span /><span />
              </div>
            )}
          </div>
        )}

        {path && (
          <>
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                <span className="tag">{path.role}</span>
                <span className="tag">{path.domain}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  {saveState === "saved" && <span style={{ color: "var(--green)", fontSize: 12.5 }}>Saved to DataHub</span>}
                  {saveState === "failed" && <span style={{ color: "var(--red)", fontSize: 12.5 }}>Save failed</span>}
                  <button className="btn" onClick={saveToDataHub} disabled={saveState === "saving" || saveState === "saved"}>
                    {saveState === "saving" ? "Saving…" : "Save to DataHub"}
                  </button>
                </div>
              </div>
              <p style={{ color: "var(--text-dim)" }}>{path.summary}</p>
              {saveState === "failed" && saveDetail && (
                <p style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{saveDetail}</p>
              )}
            </div>

            {path.days.map((day) => (
              <div key={day.day} className="card day-card">
                <div className="day-head">
                  <div className="day-num">{day.day}</div>
                  <div className="day-title">{day.title}</div>
                </div>
                {day.items.map((item, i) => (
                  <div key={i} style={{ padding: "7px 4px" }}>
                    <div style={{ fontWeight: 570 }}>{item.title}</div>
                    <div className="check-detail">{item.detail}</div>
                    {item.urn && <div className="urn">{item.urn}</div>}
                  </div>
                ))}
              </div>
            ))}

            <p style={{ color: "var(--text-faint)", fontSize: 12.5, marginTop: 8 }}>
              Track your completion on the <a href="/progress">Progress</a> page.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
