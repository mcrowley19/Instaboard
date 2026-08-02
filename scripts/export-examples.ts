/**
 * Export the stored runbooks into `examples/runbooks/` so their quality is
 * judgeable without running anything.
 *
 *   npm run examples
 *
 * Three files per runbook, all of them real artifacts rather than illustrations:
 *
 *   <id>.md              the runbook exactly as it is written back to DataHub
 *   <id>.json            the same runbook with its catalog baseline — every
 *                        snapshot, every fingerprint, every pinned claim
 *   <id>.validation.md   the drift note from its last validation, which is the
 *                        document that lands in the catalog when it goes stale
 *
 * Nothing here is hand-maintained. Re-run after `npm run validate` and the
 * examples are whatever the tool actually produced against a live catalog.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decayToMarkdown } from "../lib/decay";
import { handoffToMarkdown, listHandoffs } from "../lib/handoff-store";

const OUT = path.join(process.cwd(), "examples", "runbooks");

function main(): void {
  const handoffs = listHandoffs();
  if (handoffs.length === 0) {
    console.log("No runbooks stored, so nothing to export.");
    return;
  }

  mkdirSync(OUT, { recursive: true });
  // Drop previously exported runbooks so a deleted one doesn't linger as an example.
  for (const file of readdirSync(OUT)) {
    if (file !== "README.md") rmSync(path.join(OUT, file));
  }

  const index: string[] = [];

  for (const handoff of handoffs) {
    writeFileSync(path.join(OUT, `${handoff.id}.md`), handoffToMarkdown(handoff));
    writeFileSync(path.join(OUT, `${handoff.id}.json`), JSON.stringify(handoff, null, 2));

    let validation = "";
    if (handoff.decay) {
      validation = `${handoff.id}.validation.md`;
      writeFileSync(path.join(OUT, validation), decayToMarkdown(handoff, handoff.decay));
    }

    const claims = handoff.decay?.claims?.length ?? 0;
    const holds = handoff.decay?.verdicts?.filter((v) => v.status === "holds").length ?? 0;
    const severity = handoff.decay?.severity ?? "not yet validated";
    index.push(
      `| [\`${handoff.id}.md\`](${handoff.id}.md) | ${handoff.title} | ${handoff.steps.length} | ` +
        `${claims ? `${holds}/${claims}` : "—"} | ${severity} | ` +
        `${validation ? `[report](${validation})` : "—"} |`
    );

    console.log(
      `✓ ${handoff.id}: ${handoff.steps.length} steps, ${Object.keys(handoff.snapshots ?? {}).length} snapshots, ` +
        `${claims} claims, severity ${severity}`
    );
  }

  console.log(`\nwrote ${handoffs.length} runbook(s) to ${path.relative(process.cwd(), OUT)}/`);
  console.log("\nPaste this into examples/runbooks/README.md if the table needs refreshing:\n");
  console.log("| Runbook | Task | Steps | Claims holding | Last validation | Report |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  console.log(index.join("\n"));
}

main();
