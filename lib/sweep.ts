/**
 * One runbook-decay sweep: re-check every stored runbook against the catalog,
 * write what drifted back into DataHub, and report what happened.
 *
 * Shared by `npm run validate` (the unattended/cron entry point) and the
 * showcase drill's receipt capture, so the receipts a judge reads are produced
 * by the same code the cron job runs, rather than by a reporting script walking
 * its own parallel path.
 */

import { detectDecay, writeBackDecay, type WriteBackReceipt } from "./decay";
import { writeBackNative, type NativeWriteBackReceipt } from "./native-writeback";
import { listHandoffs, saveHandoff } from "./handoff-store";
import type { DecayFinding, DecayReport } from "./types";

export interface SweepRow {
  id: string;
  title: string;
  severity: DecayReport["severity"];
  findings: DecayFinding[];
  stepsChecked: number;
  entitiesChecked: number;
  /** The drift-note Document write-back. */
  receipt: WriteBackReceipt | null;
  /** The native write-back: incidents raised, datasets tagged. */
  native: NativeWriteBackReceipt | null;
}

export interface SweepResult {
  at: string;
  rows: SweepRow[];
  checked: number;
  drifted: number;
  broken: number;
}

export async function sweepRunbooks(filter?: string): Promise<SweepResult> {
  const handoffs = listHandoffs().filter((h) => !filter || h.id.includes(filter));
  const rows: SweepRow[] = [];

  for (const handoff of handoffs) {
    const report = await detectDecay(handoff);
    handoff.decay = report;
    saveHandoff(handoff);

    let receipt: WriteBackReceipt | null = null;
    let native: NativeWriteBackReceipt | null = null;
    if (report.severity !== "ok") {
      receipt = await writeBackDecay(handoff, report);
      native = await writeBackNative(handoff, report, receipt.documentUrn);
    }

    rows.push({
      id: handoff.id,
      title: handoff.title,
      severity: report.severity,
      findings: report.findings,
      stepsChecked: report.stepsChecked,
      entitiesChecked: report.entitiesChecked,
      receipt,
      native,
    });
  }

  return {
    at: new Date().toISOString(),
    rows,
    checked: rows.length,
    drifted: rows.filter((r) => r.severity !== "ok").length,
    broken: rows.filter((r) => r.severity === "broken").length,
  };
}
