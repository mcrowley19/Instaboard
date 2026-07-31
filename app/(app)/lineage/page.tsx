"use client";

import { useState } from "react";
import Markdown from "@/components/Markdown";
import ToolTrace, { type TraceEntry } from "@/components/ToolTrace";
import { llmHeaders } from "@/lib/settings";
import { streamAgent } from "@/lib/stream-client";

interface DatasetHit {
  urn: string;
  name: string;
  platform: string;
}

const DATASET_URN_RE = /urn:li:dataset:\(urn:li:dataPlatform:([^,]+),([^,]+),([A-Z]+)\)/g;

/** Pull dataset URNs out of the raw MCP search result text. */
function extractDatasets(raw: string): DatasetHit[] {
  const seen = new Map<string, DatasetHit>();
  for (const match of raw.matchAll(DATASET_URN_RE)) {
    const urn = match[0];
    if (!seen.has(urn)) {
      seen.set(urn, { urn, name: match[2], platform: match[1] });
    }
  }
  return [...seen.values()];
}

export default function LineagePage() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DatasetHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<DatasetHit | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim() || searching) return;
    setSearching(true);
    setError(null);
    setHits([]);
    try {
      const res = await fetch(`/api/lineage?q=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "search failed");
      const found = extractDatasets(data.raw ?? "");
      setHits(found);
      if (found.length === 0) setError("No datasets found — is DataHub running and seeded? (npm run seed)");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const explain = async (hit: DatasetHit) => {
    setSelected(hit);
    setExplaining(true);
    setExplanation("");
    setTraces([]);
    setError(null);
    try {
      await streamAgent("/api/lineage", { urn: hit.urn }, llmHeaders(), (event) => {
        if (event.type === "text") {
          setExplanation((prev) => (prev ? prev + "\n" : "") + event.text);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplaining(false);
    }
  };

  return (
    <div className="page">
      <div className="page-narrow">
        <h1 className="page-title">Lineage Explainer</h1>
        <p className="page-sub">
          Pick a dataset to see where its data comes from, who consumes it, and what breaks if it changes.
        </p>

        <div className="form-row">
          <div className="form-field" style={{ flex: 1 }}>
            <label className="label">Find a dataset</label>
            <input
              className="input"
              value={query}
              placeholder="users, payments, orders…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
          </div>
          <button className="btn btn-primary" onClick={search} disabled={searching || !query.trim()}>
            {searching ? "Searching…" : "Search DataHub"}
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {hits.length > 0 && !selected && (
          <div style={{ marginBottom: 24 }}>
            <div className="col-label">
              {hits.length} dataset{hits.length === 1 ? "" : "s"} found
            </div>
            {hits.map((h) => (
              <div key={h.urn} className="result-item" onClick={() => explain(h)}>
                <div style={{ fontWeight: 570 }}>
                  {h.name} <span className="tag" style={{ marginLeft: 6 }}>{h.platform}</span>
                </div>
                <div className="urn">{h.urn}</div>
              </div>
            ))}
          </div>
        )}

        {selected && (
          <>
            <div className="card" style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 650 }}>{selected.name}</span>
                <span className="tag">{selected.platform}</span>
                <button className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setSelected(null)}>
                  ← back to results
                </button>
              </div>
              <div className="urn" style={{ marginTop: 6 }}>{selected.urn}</div>
            </div>

            {traces.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div className="col-label">Lineage calls ({traces.length})</div>
                {traces.map((t) => (
                  <ToolTrace key={t.id} entry={t} />
                ))}
              </div>
            )}

            {explaining && !explanation && (
              <div className="thinking">
                <span /><span /><span />
              </div>
            )}

            {explanation && (
              <div className="card">
                <Markdown>{explanation}</Markdown>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
