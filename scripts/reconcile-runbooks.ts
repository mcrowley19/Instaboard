/**
 * Reconcile every stored runbook against its Document in DataHub, by content
 * hash. The catalog is the body of record.
 *
 *   npm run reconcile              # report, and pull any body edited in DataHub
 *   npm run reconcile -- --push    # also push runbooks that changed locally
 *   npm run reconcile -- --filter=revenue --json
 *
 * Four honest states per runbook, decided by a three-way digest compare (the
 * catalog now, the local rendering now, both as of the last sync):
 *
 *   in-sync        nothing moved on either side
 *   catalog-ahead  somebody edited the document in DataHub → the catalog wins,
 *                  and the edited body is pulled onto the handoff verbatim
 *   local-ahead    the runbook changed here (a correction was applied) and the
 *                  catalog has not moved → pushed only with --push, and the
 *                  push re-checks the digest first
 *   conflict       both sides moved → nobody is overwritten; a person merges
 *
 * Exits non-zero when any runbook is in conflict, so a cron pass turns silent
 * divergence into a failing job. Receipts land in
 * examples/live/reconcile-receipts.json.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listHandoffs } from "../lib/handoff-store";
import { isDemoMode } from "../lib/mcp";
import { pushHandoffDocument, reconcileHandoff, type SyncReceipt } from "../lib/runbook-sync";

const args = process.argv.slice(2);
const json = args.includes("--json");
const push = args.includes("--push");
const filter = args.find((a) => a.startsWith("--filter="))?.split("=")[1];

const OUT = path.join(process.cwd(), "examples", "live", "reconcile-receipts.json");

const ICON: Record<SyncReceipt["status"], string> = {
  "in-sync": "✓",
  "catalog-ahead": "⇣",
  "local-ahead": "⇡",
  conflict: "✗",
  unwritten: "·",
  "catalog-missing": "?",
  unreachable: "!",
};

async function main() {
  if (isDemoMode()) {
    console.error("DEMO_MODE is set. Reconciling against a fixture would be theatre; unset it.");
    process.exit(1);
  }

  const handoffs = listHandoffs().filter((h) => !filter || h.id.includes(filter));
  if (handoffs.length === 0) {
    console.log(`No runbooks${filter ? ` matching "${filter}"` : ""} stored, so nothing to reconcile.`);
    return;
  }

  const receipts: SyncReceipt[] = [];
  for (const handoff of handoffs) {
    let receipt = await reconcileHandoff(handoff);
    if (push && receipt.status === "local-ahead") {
      receipt = await pushHandoffDocument(handoff);
    }
    receipts.push(receipt);
    if (!json) {
      console.log(`${ICON[receipt.status]} ${handoff.id} — ${receipt.status}${receipt.action === "none" ? "" : `, ${receipt.action}`}`);
      console.log(`    ${receipt.detail}`);
    }
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        gms: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
        method:
          "Each stored runbook was compared against its Document in DataHub by normalized sha256 content digest, " +
          "three ways: catalog now, local rendering now, both as of the last sync. Catalog edits are pulled and " +
          "recorded verbatim; pushes are compare-and-set on the digest; conflicts are left for a person.",
        receipts,
      },
      null,
      2
    ) + "\n"
  );

  const conflicts = receipts.filter((r) => r.status === "conflict");
  if (json) {
    console.log(JSON.stringify(receipts, null, 2));
  } else {
    console.log(
      `\n${receipts.length} runbook(s): ` +
        (["in-sync", "catalog-ahead", "local-ahead", "conflict", "unwritten", "catalog-missing", "unreachable"] as const)
          .map((s) => [s, receipts.filter((r) => r.status === s).length] as const)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${n} ${s}`)
          .join(", ") +
        `. Receipts written to ${path.relative(process.cwd(), OUT)}.`
    );
  }
  process.exit(conflicts.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
