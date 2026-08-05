"use client";

import { useEffect, useState } from "react";
import { itemKey, loadPath, loadProgress, saveProgress } from "@/lib/path-storage";
import type { LearningPath } from "@/lib/types";

export default function ProgressPage() {
  const [path, setPath] = useState<LearningPath | null>(null);
  const [progress, setProgress] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPath(loadPath());
    setProgress(loadProgress());
    setReady(true);
  }, []);

  const toggle = (key: string) => {
    setProgress((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveProgress(next);
      return next;
    });
  };

  if (!ready) return null;

  if (!path) {
    return (
      <div className="page">
        <div className="page-narrow empty-state" style={{ minHeight: "60vh" }}>
          <h2>No learning path yet</h2>
          <p>
            Generate a <a href="/path">Week 1 learning path</a> first — then check items off here as
            you ramp up.
          </p>
        </div>
      </div>
    );
  }

  const total = path.days.reduce((n, d) => n + d.items.length, 0);
  const done = path.days.reduce(
    (n, d) => n + d.items.filter((_, i) => progress[itemKey(d.day, i)]).length,
    0
  );
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="page">
      <div className="page-narrow">
        <h1 className="page-title">Onboarding Progress</h1>
        <p className="page-sub">
          {path.role} · {path.domain} — {done}/{total} complete ({pct}%)
        </p>

        <div className="progress-bar">
          <div style={{ width: `${pct}%` }} />
        </div>

        {path.days.map((day) => (
          <div key={day.day} className="card day-card">
            <div className="day-head">
              <div className="day-num">{day.day}</div>
              <div className="day-title">{day.title}</div>
            </div>
            {day.items.map((item, i) => {
              const key = itemKey(day.day, i);
              const checked = Boolean(progress[key]);
              return (
                <label key={key} className={`check-item ${checked ? "done" : ""}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(key)} />
                  <div className="ct">
                    <div>{item.title}</div>
                    <div className="check-detail">{item.detail}</div>
                  </div>
                </label>
              );
            })}
          </div>
        ))}

        {pct === 100 && (
          <div className="card" style={{ textAlign: "center", borderColor: "var(--green)" }}>
            Week 1 complete. You know your way around the catalog.
          </div>
        )}
      </div>
    </div>
  );
}
