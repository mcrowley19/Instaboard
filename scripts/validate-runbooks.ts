/**
 * Autonomous runbook validation sweep.
 *
 *   npm run validate               # validate every stored runbook
 *   npm run validate -- --json     # machine-readable output
 *
 * Re-checks every stored runbook against the catalog (live DataHub, or the
 * demo fixture with DEMO_MODE=true), writes a drift note back into DataHub for
 * anything stale, and exits non-zero if any runbook is broken — so it runs the
 * same way from a cron job or CI as the Validate button does in the UI. This
 * is the decay loop as an unattended agent: knowledge is re-verified on a
 * schedule, and the warnings land in the catalog where the runbooks live.
 */

import { detectDecay, writeBackDecay, type WriteBackReceipt } from "../lib/decay";
import { listHandoffs, saveHandoff } from "../lib/handoff-store";
import type { DecayReport } from "../lib/types";

const json = process.argv.includes("--json");

interface SweepRow {
  id: string;
  title: string;
  severity: DecayReport["severity"];
  findings: number;
  stepsChecked: number;
  receipt: WriteBackReceipt | null;
}

async function main() {
  const handoffs = listHandoffs();
  if (handoffs.length === 0) {
    console.log(json ? "[]" : "No runbooks stored — nothing to validate.");
    return;
  }

  const rows: SweepRow[] = [];
  for (const handoff of handoffs) {
    const report = await detectDecay(handoff);
    handoff.decay = report;
    saveHandoff(handoff);

    let receipt: WriteBackReceipt | null = null;
    if (report.severity !== "ok") {
      receipt = await writeBackDecay(handoff, report);
    }

    rows.push({
      id: handoff.id,
      title: handoff.title,
      severity: report.severity,
      findings: report.findings.length,
      stepsChecked: report.stepsChecked,
      receipt,
    });
  }

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const icon = { ok: "✅", warning: "⚠️", broken: "🛑" } as const;
    for (const r of rows) {
      const wb = r.receipt?.written
        ? ` → note written to DataHub${r.receipt.documentUrn ? ` (${r.receipt.documentUrn})` : ""}`
        : "";
      console.log(
        `${icon[r.severity]} ${r.title} — ${r.findings} finding${r.findings === 1 ? "" : "s"} across ${
          r.stepsChecked
        } step${r.stepsChecked === 1 ? "" : "s"}${wb}`
      );
    }
    const broken = rows.filter((r) => r.severity === "broken").length;
    const stale = rows.filter((r) => r.severity !== "ok").length;
    console.log(
      `\n${rows.length} runbook${rows.length === 1 ? "" : "s"} checked · ${stale} with drift · ${broken} broken`
    );
  }

  if (rows.some((r) => r.severity === "broken")) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
