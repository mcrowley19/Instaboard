"use client";

/**
 * The other half of the loop, on a real catalog, from a link.
 *
 * `DriftPlayground` is read-only by design: it computes a verdict and writes
 * nothing, which is what makes it safe to publish. But the claim this project
 * actually makes is that DataHub carries the state — an incident fires, a tag
 * lands, an assertion goes FAILING, and all three come back down when the
 * runbook is repaired. That half only existed behind `git clone && npm run
 * prove`.
 *
 * This runs it against whatever DataHub the deployment is pointed at, and shows
 * the state read back out of the catalog rather than the receipt that wrote it.
 * Every dataset links into DataHub's own UI, so the last step of verifying this
 * is not reading anything we rendered.
 *
 * It renders nothing at all unless the server says write-back is switched on,
 * because a disabled panel full of greyed-out buttons is worse than no panel.
 */

import { useCallback, useEffect, useState } from "react";

interface Availability {
  available: boolean;
  why?: string;
  runbook: { id: string; title: string };
  willChange: string;
  datasets: { urn: string; url: string }[];
}

interface ReadBack {
  urn: string;
  url: string;
  staleTag: { present: boolean; tags: string[] } | null;
  assertion: { urn: string; result: string; at?: number } | null;
}

interface LoopResult {
  ok: boolean;
  error?: string;
  action?: "fire" | "repair";
  broke?: string;
  restored?: string;
  comparedToRecordTime?: boolean;
  verdict?: string;
  severity?: string;
  findings?: { kind: string; detail: string; severity: string; urn: string }[];
  wrote?: {
    document: { written?: boolean; urn?: string; roundTrip?: { matches: boolean; readBack: boolean; writtenChars: number; readChars: number } };
    incidents: { urn: string; datasetUrn: string; reused: boolean; assignees: string[] }[];
    tagged: string[];
    assertions: { urn: string; datasetUrn: string; result: string }[];
    errors: string[];
  };
  retractionEarned?: boolean;
  retracted?: {
    incidents: { urn: string; datasetUrn: string }[];
    untagged: string[];
    kept: { datasetUrn: string; heldBy: string[] }[];
    assertions: { urn: string; datasetUrn: string; result: string }[];
    errors: string[];
  };
  readBack?: ReadBack[];
  tookMs?: number;
}

const shortName = (urn: string) => urn.split(",")[1]?.split(".").pop() ?? urn;

export default function WriteBackPlayground() {
  const [info, setInfo] = useState<Availability | null>(null);
  const [result, setResult] = useState<LoopResult | null>(null);
  const [busy, setBusy] = useState<"fire" | "repair" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/demo/writeback");
        setInfo((await res.json()) as Availability);
      } catch {
        /* leave it unrendered — this panel is additive */
      }
    })();
  }, []);

  const run = useCallback(async (action: "fire" | "repair") => {
    setBusy(action);
    setFailed(null);
    try {
      const res = await fetch("/api/demo/writeback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as LoopResult;
      if (!res.ok) throw new Error(data.error || String(res.status));
      setResult(data);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  // Nothing to offer on a deployment without a writable catalog. Saying so in a
  // dead panel would just be noise on the page that matters most.
  if (!info?.available) return null;

  const fired = result?.action === "fire";

  return (
    <div className="lp-play">
      <div className="lp-play-controls">
        <div className="lp-play-label">
          Now the write-back, on a real DataHub. <b>{info.willChange}</b> Then watch the incident, the tag and the
          assertion land — and go again when it is repaired.
        </div>
        <div className="lp-play-buttons">
          <button type="button" className="lp-play-btn" onClick={() => void run("fire")} disabled={busy !== null}>
            {busy === "fire" ? "breaking the catalog…" : "1. Inject drift"}
          </button>
          <button
            type="button"
            className="lp-play-btn reset"
            onClick={() => void run("repair")}
            disabled={busy !== null}
          >
            {busy === "repair" ? "repairing…" : "2. Repair it"}
          </button>
        </div>
      </div>

      <div className="lp-decay">
        <div className="lp-trace-head">
          <span className={`dot ${fired ? "warn" : ""}`} />
          <span>DataHub write-back</span>
          <span className="grow">{info.runbook.title}</span>
        </div>

        <div className="lp-decay-body">
          {failed && (
            <div className="lp-decay-row">
              <span className="lp-decay-badge">error</span>
              <div>{failed}</div>
            </div>
          )}

          {result?.error && (
            <div className="lp-decay-row">
              <span className="lp-decay-badge">error</span>
              <div>{result.error}</div>
            </div>
          )}

          {result?.ok && (
            <div className="lp-decay-row">
              <span className="lp-decay-badge">{result.action}</span>
              <div>
                <b className={`lp-verdict ${result.severity === "ok" ? "ok" : "bad"}`}>{result.verdict}</b> —{" "}
                {result.broke ?? result.restored}
                <span className="lp-decay-remedy">
                  {result.findings?.length
                    ? `${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}: ${result.findings
                        .map((f) => f.kind)
                        .join(", ")}`
                    : "no findings — every claim the runbook makes about the catalog holds again"}
                  {result.action === "repair" && result.comparedToRecordTime === false
                    ? " · no record-time baseline was held by this instance, so this compares against the catalog as it stands"
                    : ""}
                </span>
              </div>
            </div>
          )}

          {/* What was sent. Below it, what the catalog says — which is the row
              that actually settles anything. */}
          {result?.wrote && (
            <div className="lp-decay-row">
              <span className="lp-decay-badge">wrote</span>
              <div>
                <b>{result.wrote.incidents.length} incident</b>
                {result.wrote.incidents.length === 1 ? "" : "s"},{" "}
                <b>{result.wrote.tagged.length} tagged</b>,{" "}
                <b>
                  {result.wrote.assertions.filter((a) => a.result === "FAILURE").length} assertion
                  {result.wrote.assertions.filter((a) => a.result === "FAILURE").length === 1 ? "" : "s"} failing
                </b>
                {result.wrote.document.written === false && (
                  <span className="lp-decay-remedy">
                    The drift note was <b>not</b> written — see the error below. The incident and tag above did land;
                    they are reported separately because they succeeded separately.
                  </span>
                )}
                {result.wrote.document.roundTrip && (
                  <span className="lp-decay-remedy">
                    Drift note {result.wrote.document.urn?.slice(-12)} written and read back:{" "}
                    {result.wrote.document.roundTrip.matches
                      ? `${result.wrote.document.roundTrip.readChars} characters returned, byte for byte what was sent`
                      : result.wrote.document.roundTrip.readBack
                        ? "content came back different"
                        : "DataHub would not return the body"}
                    .
                  </span>
                )}
                {result.wrote.errors.length > 0 && (
                  <span className="lp-decay-remedy">{result.wrote.errors.join(" · ")}</span>
                )}
              </div>
            </div>
          )}

          {result?.retracted && (
            <div className="lp-decay-row ok">
              <span className="lp-decay-badge">retracted</span>
              <div>
                <b>{result.retracted.incidents.length} incident resolved</b>,{" "}
                <b>{result.retracted.untagged.length} tag removed</b>,{" "}
                <b>
                  {result.retracted.assertions.filter((a) => a.result === "SUCCESS").length} assertion back to passing
                </b>
                {result.retractionEarned === false && (
                  <span className="lp-decay-remedy">
                    Nothing was retracted: the runbook did not come back clean, so something other than the injected
                    drift is still wrong. Repair clears what it caused, not everything.
                  </span>
                )}
                {result.retracted.kept.length > 0 && (
                  <span className="lp-decay-remedy">
                    {result.retracted.kept.length} dataset kept the tag — another runbook is still stale on it, and
                    clearing it would retract a warning this repair did not earn.
                  </span>
                )}
                {result.retracted.errors.length > 0 && (
                  <span className="lp-decay-remedy">{result.retracted.errors.join(" · ")}</span>
                )}
              </div>
            </div>
          )}

          {/* Read straight back off DataHub after the writes, not derived from
              them. This is the row a sceptic should be reading. */}
          {result?.readBack?.map((r) => {
            // What we wrote for this dataset, so a read-back that disagrees can
            // say so rather than sitting silently under a receipt that
            // contradicts it. Assertion *results* are timeseries data and index
            // a beat behind the upsert, so a brief disagreement is expected and
            // a lasting one is a finding — either way it gets named.
            const wroteHere = (result.wrote?.assertions ?? result.retracted?.assertions ?? []).find(
              (a) => a.datasetUrn === r.urn
            );
            const lagging = Boolean(wroteHere && r.assertion && r.assertion.result !== wroteHere.result);
            return (
            <div key={r.urn} className={`lp-decay-row${r.staleTag?.present ? "" : " ok"}`}>
              <span className="lp-decay-badge">{shortName(r.urn)}</span>
              <div>
                <b>Stale Runbook tag: {r.staleTag?.present ? "present" : "absent"}</b>
                {r.assertion ? ` · assertion ${r.assertion.result}` : " · no assertion written"}
                {lagging && (
                  <span className="lp-decay-remedy">
                    We wrote <b>{wroteHere!.result}</b> and the catalog still reports{" "}
                    <b>{r.assertion!.result}</b>. Assertion results are timeseries data and land in their own index
                    a beat after the write, so this is the read catching up rather than the write failing — but it
                    is shown, not smoothed over.
                  </span>
                )}
                <span className="lp-decay-remedy">
                  <a href={r.url} target="_blank" rel="noreferrer">
                    open this dataset in DataHub
                  </a>{" "}
                  and check it yourself — this row is a read of the catalog, not of our receipt.
                </span>
              </div>
            </div>
            );
          })}
        </div>

        <div className="lp-decay-foot">
          <span className="tick">●</span>
          {busy
            ? "writing to DataHub…"
            : "the same functions npm run prove calls, against a live catalog, with every write read back"}
          <span className="grow">{result?.tookMs ? `${(result.tookMs / 1000).toFixed(1)}s` : "writeBackNative"}</span>
        </div>
      </div>

      <p className="lp-note">
        This writes to a real DataHub and then puts it back. The column is dropped for as long as the validation
        takes and restored before the response returns, one visitor at a time, and the only entities it can touch are
        the three this runbook names — there is no parameter that points it anywhere else. It is meant for a
        disposable catalog. The identical sequence runs in{" "}
        <a href="https://github.com/mcrowley19/Instaboard/blob/main/.github/workflows/prove.yml">CI on every push</a>,
        against a DataHub booted from nothing, and the committed receipts have to match what it produces.
      </p>
    </div>
  );
}
