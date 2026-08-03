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
 *   4. **coverage** — the figure for how much of the runbook could be checked at
 *      all, as a structured property, plus an `Unvalidated Runbook Step` tag on
 *      any dataset the catalog held too little about to answer for;
 *   5. a **proposed correction**, derived from the catalog and left for a human to
 *      approve.
 *
 * And all of it comes back off. When a runbook validates clean the incidents are
 * resolved, the assertion goes back to passing and the stale tag is retracted —
 * guarded, because the tag is shared with any other runbook that reads the same
 * dataset. A sweep that only ever adds state ends up as a catalog full of warnings
 * about problems fixed months ago, which is the same as no warnings at all.
 */

import { detectDecayWithState, writeBackDecay, type WriteBackReceipt } from "./decay";
import {
  resolveIncidentsFor,
  retractStaleTags,
  writeBackCoverage,
  writeBackNative,
  type CoverageTagReceipt,
  type NativeWriteBackReceipt,
  type RetractionReceipt,
} from "./native-writeback";
import { writeStructuredState, type StructuredStateReceipt } from "./structured-state";
import { proposeFix, type RunbookProposal } from "./remediate";
import { listHandoffs, saveHandoff } from "./handoff-store";
import type { DecayFinding, DecayReport, Handoff } from "./types";

export interface SweepRow {
  id: string;
  title: string;
  severity: DecayReport["severity"];
  /** PASS / FINDING / INSUFFICIENT_DATA — see `RunbookVerdict`. */
  verdict: DecayReport["verdict"];
  /** What this run was able to check, and what the catalog could not answer. */
  coverage: DecayReport["coverage"];
  findings: DecayFinding[];
  stepsChecked: number;
  entitiesChecked: number;
  /** How many of the runbook's individual catalog claims still hold. */
  claims: { total: number; holds: number; broken: number; unvalidatable: number; unverified: number };
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
  /** Stale Runbook tags taken back down because the runbook is repaired. */
  retracted: RetractionReceipt | null;
  /** The unvalidatable-step tag, applied and retracted with the catalog's gaps. */
  coverageTags: CoverageTagReceipt | null;
}

export interface SweepResult {
  at: string;
  rows: SweepRow[];
  checked: number;
  drifted: number;
  broken: number;
  /** Runbooks that drifted nowhere but could not be fully checked either. */
  insufficient: number;
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

  // Coverage is written on every run too, and for the same reason: the run this
  // matters most for is the one that found nothing.
  const coverageTags = await writeBackCoverage(handoff, report);

  // A detector that only ever opens incidents — or only ever applies tags —
  // becomes noise. When the runbook validates clean again, close what it opened
  // and take back what it applied.
  const touchedUrns = [...new Set(handoff.steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];
  let resolved: { urn: string; datasetUrn: string }[] = [];
  let retracted: RetractionReceipt | null = null;
  if (report.severity === "ok" && structured.attempted) {
    resolved = await resolveIncidentsFor(handoff, touchedUrns);
    // After the status property is written, so the guard reads this run's own
    // "validated" rather than the previous run's "stale".
    retracted = await retractStaleTags(handoff, touchedUrns);
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
      verdict: report.verdict,
      coverage: report.coverage,
      findings: report.findings,
      stepsChecked: report.stepsChecked,
      entitiesChecked: report.entitiesChecked,
      claims: {
        total: verdicts.length,
        holds: verdicts.filter((v) => v.status === "holds").length,
        broken: verdicts.filter((v) => v.status === "broken").length,
        unvalidatable: verdicts.filter((v) => v.status === "unvalidatable").length,
        unverified: verdicts.filter((v) => v.status === "unverified").length,
      },
      receipt,
      native,
      structured,
      proposal,
      resolved,
      retracted,
      coverageTags,
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
    insufficient: rows.filter((r) => r.verdict === "INSUFFICIENT_DATA").length,
  };
}
