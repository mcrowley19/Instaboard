/**
 * One runbook-decay sweep: re-check every stored runbook against the catalog,
 * write what drifted back into DataHub, propose the correction, and report what
 * happened.
 *
 * Shared by `npm run validate` (the unattended/cron entry point), `npm run prove`
 * (the end-to-end proof) and the showcase drill's receipt capture, so the receipts
 * a judge reads are produced by the same code the cron job runs, rather than by a
 * reporting script walking its own parallel path.
 *
 * The write-back happens at four levels, in ascending order of how hard it is to
 * ignore:
 *
 *   1. a **drift-note Document** carrying the full report and its provenance
 *      chain, linked to the drifted datasets;
 *   2. **structured state** — a custom assertion that fails while the runbook is
 *      stale, plus structured properties holding the status, the specific change
 *      that broke it, and the version each claim was validated against;
 *   3. **native primitives** — a `Stale Runbook` tag on every drifted dataset and
 *      a real Incident, assigned to whoever owns the dataset today, on any dataset
 *      where a step would now fail;
 *   4. a **proposed correction**, derived from the catalog and left for a human to
 *      approve.
 */

import { detectDecayWithState, writeBackDecay, type WriteBackReceipt } from "./decay";
import { resolveIncidentsFor, writeBackNative, type NativeWriteBackReceipt } from "./native-writeback";
import { writeStructuredState, type StructuredStateReceipt } from "./structured-state";
import { proposeFix, type RunbookProposal } from "./remediate";
import { listHandoffs, saveHandoff } from "./handoff-store";
import type { DecayFinding, DecayReport, Handoff } from "./types";

export interface SweepRow {
  id: string;
  title: string;
  severity: DecayReport["severity"];
  findings: DecayFinding[];
  stepsChecked: number;
  entitiesChecked: number;
  /** How many of the runbook's individual catalog claims still hold. */
  claims: { total: number; holds: number; broken: number; unverified: number };
  /** The drift-note Document write-back. */
  receipt: WriteBackReceipt | null;
  /** The native write-back: incidents raised and assigned, datasets tagged. */
  native: NativeWriteBackReceipt | null;
  /** The structured write-back: failing assertion, structured properties. */
  structured: StructuredStateReceipt | null;
  /** The correction awaiting human approval, when anything could be corrected. */
  proposal: RunbookProposal | null;
  /** Incidents this tool had raised for the runbook and has now closed. */
  resolved: { urn: string; datasetUrn: string }[];
}

export interface SweepResult {
  at: string;
  rows: SweepRow[];
  checked: number;
  drifted: number;
  broken: number;
}

export interface SweepOptions {
  /** Only sweep runbooks whose id contains this. */
  filter?: string;
  /** Derive corrections for what drifted. On by default. */
  propose?: boolean;
}

/**
 * One runbook, validated and written back.
 *
 * Shared by the sweep and by the app's Validate button, so pressing the button
 * and running the cron job do exactly the same thing — the alternative is two
 * code paths that drift apart and a demo that shows something the unattended
 * pass doesn't do.
 */
export async function validateRunbook(
  handoff: Handoff,
  options: { propose?: boolean } = {}
): Promise<{ row: SweepRow; report: DecayReport }> {
  const { propose = true } = options;
  const { report, live } = await detectDecayWithState(handoff);
  handoff.decay = report;
  saveHandoff(handoff);

  let receipt: WriteBackReceipt | null = null;
  let native: NativeWriteBackReceipt | null = null;
  let proposal: RunbookProposal | null = null;

  // Structured state is written on every run, drift or not: "re-validated today
  // and still holds" is what makes the absence of a warning mean something.
  const structured = await writeStructuredState(handoff, report);

  // A detector that only ever opens incidents becomes noise. When the runbook
  // validates clean again, close the ones it opened.
  let resolved: { urn: string; datasetUrn: string }[] = [];
  if (report.severity === "ok" && structured.attempted) {
    resolved = await resolveIncidentsFor(
      handoff,
      [...new Set(handoff.steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))]
    );
  }

  if (report.severity !== "ok") {
    receipt = await writeBackDecay(handoff, report);
    proposal = propose ? proposeFix(handoff, report, live) : null;
    native = await writeBackNative(handoff, report, receipt.documentUrn, live, {
      ...(proposal?.edits.length
        ? {
            summary:
              `${proposal.edits.length} edit${proposal.edits.length === 1 ? "" : "s"} derived from the catalog` +
              `${proposal.unresolved.length ? `, ${proposal.unresolved.length} finding(s) left for a person` : ""}.`,
          }
        : {}),
    });
  }

  const verdicts = report.verdicts ?? [];
  return {
    report,
    row: {
      id: handoff.id,
      title: handoff.title,
      severity: report.severity,
      findings: report.findings,
      stepsChecked: report.stepsChecked,
      entitiesChecked: report.entitiesChecked,
      claims: {
        total: verdicts.length,
        holds: verdicts.filter((v) => v.status === "holds").length,
        broken: verdicts.filter((v) => v.status === "broken").length,
        unverified: verdicts.filter((v) => v.status === "unverified").length,
      },
      receipt,
      native,
      structured,
      proposal,
      resolved,
    },
  };
}

export async function sweepRunbooks(options: SweepOptions | string = {}): Promise<SweepResult> {
  const { filter, propose = true } = typeof options === "string" ? { filter: options } : options;
  const handoffs = listHandoffs().filter((h) => !filter || h.id.includes(filter));
  const rows: SweepRow[] = [];

  for (const handoff of handoffs) {
    rows.push((await validateRunbook(handoff, { propose })).row);
  }

  return {
    at: new Date().toISOString(),
    rows,
    checked: rows.length,
    drifted: rows.filter((r) => r.severity !== "ok").length,
    broken: rows.filter((r) => r.severity === "broken").length,
  };
}
