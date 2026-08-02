/**
 * Autonomous runbook validation sweep.
 *
 *   npm run validate                        # validate every stored runbook
 *   npm run validate -- --json              # machine-readable output
 *   npm run validate -- --filter=showcase   # only runbooks whose id matches
 *
 * Re-checks every stored runbook against the catalog (live DataHub, or the
 * demo fixture with DEMO_MODE=true), writes the drift back into DataHub, and
 * exits non-zero if any runbook is broken, so a cron job or CI run behaves the
 * same way the Validate button does in the UI. This is the decay loop running
 * unattended. Knowledge gets re-verified on a schedule, and the warnings land in
 * the catalog where the runbooks live.
 *
 * Drift is written back at two levels:
 *   1. a **drift-note Document**, carrying the full report and linked to the
 *      drifted datasets;
 *   2. **native primitives**, meaning a `Stale Runbook` tag on every drifted
 *      dataset and a real Incident on any dataset where a step would now fail.
 *      That second level surfaces the finding in workflows a data team already
 *      watches instead of in a document somebody has to open.
 */

import { sweepRunbooks } from "../lib/sweep";

const json = process.argv.includes("--json");
const filter = process.argv.find((a) => a.startsWith("--filter="))?.split("=")[1];

async function main() {
  const sweep = await sweepRunbooks(filter);

  if (sweep.checked === 0) {
    console.log(json ? "[]" : `No runbooks${filter ? ` matching "${filter}"` : ""} stored, so nothing to validate.`);
    process.exit(0);
  }

  if (json) {
    console.log(JSON.stringify(sweep, null, 2));
  } else {
    const icon = { ok: "✅", warning: "⚠️", broken: "🛑" } as const;
    for (const r of sweep.rows) {
      const wb = r.receipt?.written
        ? ` → note written to DataHub${r.receipt.documentUrn ? ` (${r.receipt.documentUrn})` : ""}`
        : "";
      console.log(
        `${icon[r.severity]} ${r.title}: ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} across ${
          r.stepsChecked
        } step${r.stepsChecked === 1 ? "" : "s"}${wb}`
      );
      for (const f of r.findings) {
        console.log(`    ${f.severity === "broken" ? "🛑" : "⚠️"} step ${f.stepIndex + 1} · ${f.kind}: ${f.detail}`);
      }
      if (r.native?.attempted) {
        if (r.native.tagged.length) {
          console.log(`    🏷  tagged 'Stale Runbook' on ${r.native.tagged.length} dataset(s)`);
        }
        for (const inc of r.native.incidents) {
          console.log(`    🚨 ${inc.reused ? "incident already open" : "incident raised"}: ${inc.urn}`);
          console.log(`         on ${inc.datasetUrn}`);
        }
        for (const e of r.native.errors) console.log(`    ⚠️  ${e}`);
      }
    }
    console.log(
      `\n${sweep.checked} runbook${sweep.checked === 1 ? "" : "s"} checked · ${sweep.drifted} with drift · ${
        sweep.broken
      } broken`
    );
  }

  // Non-zero when any runbook would fail if followed. Cron it, or gate CI on it.
  process.exit(sweep.broken > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
