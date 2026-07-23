"use client";

import { useState } from "react";

export interface TraceEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  pending: boolean;
}

/**
 * Collapsible trace of a single DataHub MCP tool call — proof for judges
 * (and users) that answers come from the live catalog, not the model.
 */
export default function ToolTrace({ entry }: { entry: TraceEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="trace">
      <button className="trace-head" onClick={() => setOpen(!open)}>
        <span className={`chev ${open ? "open" : ""}`}>▶</span>
        <span>DataHub MCP</span>
        <span className="trace-name">{entry.name}</span>
        <span className="trace-status">
          {entry.pending ? (
            <span style={{ color: "var(--amber)" }}>running…</span>
          ) : entry.isError ? (
            <span style={{ color: "var(--red)" }}>error</span>
          ) : (
            <span style={{ color: "var(--green)" }}>✓</span>
          )}
        </span>
      </button>
      {open && (
        <div className="trace-body">
          <div className="trace-section">Arguments</div>
          <pre>{JSON.stringify(entry.args, null, 2)}</pre>
          {entry.result !== undefined && (
            <>
              <div className="trace-section">Result</div>
              <pre>{entry.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
