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
 * Drift is written back at four levels:
 *   1. a **drift-note Document**, carrying the full report and its provenance
 *      chain, linked to the drifted datasets;
 *   2. **structured state**, meaning a custom assertion that fails while the
 *      runbook is stale and structured properties recording the status, the
 *      specific change that broke it, and the version each claim was validated
 *      against. Filterable and machine-readable, not prose;
 *   3. **native primitives**, meaning a `Stale Runbook` tag on every drifted
 *      dataset and a real Incident, assigned to whoever owns the dataset today,
 *      on any dataset where a step would now fail. That surfaces the finding in
 *      workflows a data team already watches instead of in a document somebody
 *      has to open;
 *   4. a **proposed correction** derived from the catalog, written to
 *      `proposals/` by `npm run propose` for a human to approve.
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
      // A clean run that could not check everything gets its own mark, so it
      // never scans as the same outcome as a clean run that checked it all.
      const mark = r.severity === "ok" && r.verdict === "INSUFFICIENT_DATA" ? "🔍" : icon[r.severity];
      const wb = r.receipt?.written
        ? ` → note written to DataHub${r.receipt.documentUrn ? ` (${r.receipt.documentUrn})` : ""}`
        : "";
      console.log(
        `${mark} ${r.title} [${r.verdict ?? "—"}]: ${r.findings.length} finding${
          r.findings.length === 1 ? "" : "s"
        } across ${r.stepsChecked} step${r.stepsChecked === 1 ? "" : "s"}${wb}`
      );
      console.log(
        `    ${r.claims.holds}/${r.claims.total} catalog claims still hold` +
          `${r.claims.broken ? `, ${r.claims.broken} broken` : ""}` +
          `${r.claims.unvalidatable ? `, ${r.claims.unvalidatable} unvalidatable` : ""}` +
          `${r.claims.unverified ? `, ${r.claims.unverified} unverified` : ""}`
      );
      if (r.coverage) {
        console.log(`    📐 coverage: ${r.coverage.summary}`);
        for (const s of r.coverage.steps.filter((s) => s.gaps.length)) {
          console.log(`       ~ step ${s.stepIndex + 1} · ${s.detail}`);
        }
      }
      for (const f of r.findings) {
        console.log(`    ${f.severity === "broken" ? "🛑" : "⚠️"} step ${f.stepIndex + 1} · ${f.kind}: ${f.detail}`);
      }
      if (r.structured?.attempted) {
        for (const a of r.structured.assertions) {
          console.log(`    📋 assertion ${a.result === "FAILURE" ? "FAILING" : "passing"}: ${a.urn}`);
          console.log(`         on ${a.datasetUrn}`);
        }
        for (const p of r.structured.properties) {
          console.log(`    🔖 ${p.status} · ${p.driftValues} drift value(s), ${p.pins} provenance pin(s)`);
          if (p.coverage) console.log(`         coverage: ${p.coverage}`);
        }
        for (const e of r.structured.errors) console.log(`    ⚠️  ${e}`);
      }
      if (r.proposal) {
        console.log(
          `    ✎ correction proposed: ${r.proposal.edits.length} edit(s), ${r.proposal.unresolved.length} left for a person` +
            `${r.proposal.reviewers.length ? ` · reviewers: ${r.proposal.reviewers.join(", ")}` : ""}`
        );
        console.log("       run `npm run propose` to write it out, `npm run propose -- --pr` to open it as a PR");
      }
      if (r.native?.attempted) {
        if (r.native.tagged.length) {
          console.log(`    🏷  tagged 'Stale Runbook' on ${r.native.tagged.length} dataset(s)`);
        }
        for (const inc of r.native.incidents) {
          console.log(`    🚨 ${inc.reused ? "incident already open" : "incident raised"}: ${inc.urn}`);
          console.log(`         on ${inc.datasetUrn}`);
          if (inc.assignees.length) console.log(`         assigned to ${inc.assignees.join(", ")}`);
        }
        for (const e of r.native.errors) console.log(`    ⚠️  ${e}`);
      }
      if (r.coverageTags?.tagged.length) {
        console.log(`    🏷  tagged 'Unvalidated Runbook Step' on ${r.coverageTags.tagged.length} dataset(s)`);
      }
      if (r.retracted?.untagged.length) {
        console.log(`    🧹 'Stale Runbook' retracted from ${r.retracted.untagged.length} dataset(s) — runbook repaired`);
      }
      for (const kept of r.retracted?.kept ?? []) {
        console.log(`    🏷  kept 'Stale Runbook' on ${kept.datasetUrn} — still stale for ${kept.heldBy.join(", ")}`);
      }
    }
    console.log(
      `\n${sweep.checked} runbook${sweep.checked === 1 ? "" : "s"} checked · ${sweep.drifted} with drift · ${
        sweep.broken
      } broken · ${sweep.insufficient} clean but not fully checkable`
    );
  }

  // Non-zero when any runbook would fail if followed. Cron it, or gate CI on it.
  process.exit(sweep.broken > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
