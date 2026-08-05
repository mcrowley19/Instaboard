/**
 * The body of record, proved: DataHub's copy of a runbook wins, by content
 * hash, and nothing this tool does can overwrite a human's edit there.
 *
 *   npm run prove:sync
 *
 * The drill walks one runbook through the whole lifecycle against a live
 * DataHub:
 *
 *   1. save the runbook as a Document and verify the round trip
 *   2. reconcile — in sync
 *   3. a steward edits the document inside DataHub (simulated through the same
 *      updateDocumentContents mutation the UI editor lands on)
 *   4. reconcile — catalog-ahead, and the catalog wins: the edit is pulled
 *      onto the handoff verbatim, nothing is written to DataHub
 *   5. a correction is applied locally; reconcile — local-ahead; push goes
 *      through compare-and-set and the catalog reads back byte for byte
 *   6. the steward edits again AND another local change lands — a real
 *      conflict; the push is REFUSED and the steward's words survive in the
 *      catalog, read back and quoted in the receipt
 *
 * Every transition asserts. Receipts land in
 * examples/live/document-sync-receipts.json; the temporary runbook and its
 * document are removed afterwards.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { datahubGraphQL, gmsReachable } from "../lib/datahub-graphql";
import { documentDigest, documentUrnFrom, readDocument, verifyDocumentRoundTrip } from "../lib/document-readback";
import { deleteHandoff, handoffToMarkdown, saveHandoff } from "../lib/handoff-store";
import { callDataHubTool, isDemoMode } from "../lib/mcp";
import { NORTHBEAM } from "../lib/prove-profiles";
import { markPullFolded, pushHandoffDocument, reconcileHandoff, type SyncReceipt } from "../lib/runbook-sync";

const json = process.argv.includes("--json");
const OUT = path.join(process.cwd(), "examples", "live", "document-sync-receipts.json");

interface Check {
  phase: string;
  what: string;
  passed: boolean;
  detail: string;
}
const checks: Check[] = [];
const syncs: (SyncReceipt & { phase: string })[] = [];

function check(phase: string, what: string, passed: boolean, detail: string): boolean {
  checks.push({ phase, what, passed, detail });
  if (!json) console.log(`    ${passed ? "✓" : "✗"} ${what} — ${detail}`);
  return passed;
}
const say = (m: string) => {
  if (!json) console.log(m);
};
const record = (phase: string, receipt: SyncReceipt) => {
  syncs.push({ phase, ...receipt });
  return receipt;
};

const UPDATE_DOCUMENT_CONTENTS = `
  mutation updateDocumentContents($input: UpdateDocumentContentsInput!) { updateDocumentContents(input: $input) }
`;
const DELETE_DOCUMENT = `
  mutation deleteDocument($urn: String!) { deleteDocument(urn: $urn) }
`;

const STEWARD_EDIT_1 = "> **Steward's note (edited in DataHub):** reconcile against the ledger before quoting anything.";
const STEWARD_EDIT_2 = "> **Steward's second note:** the ledger moved to close-plus-two; do not quote before then.";

async function main() {
  if (isDemoMode()) {
    console.error("DEMO_MODE is set. This proves the body of record against a real DataHub, so unset it.");
    process.exit(1);
  }
  if (!(await gmsReachable())) {
    console.error("GMS is not answering. Start DataHub (npm run datahub:up) and seed it (npm run seed) first.");
    process.exit(1);
  }

  const started = new Date().toISOString();
  const handoff = NORTHBEAM.runbook();
  handoff.id = "prove-body-of-record";
  handoff.title = "Body of record drill";

  say("\n1/6  save the runbook as the body of record");
  const markdown = handoffToMarkdown(handoff);
  const doc = await callDataHubTool("save_document", {
    document_type: "Note",
    title: `Handoff: ${handoff.title}`,
    content: markdown,
    topics: ["onboarding", "handoff"],
    related_assets: handoff.steps.map((s) => s.urn).filter(Boolean).slice(0, 10),
  });
  const documentUrn = documentUrnFrom(doc);
  if (!documentUrn) {
    check("save", "the document was created", false, doc.content.slice(0, 200));
    return finish(started, undefined);
  }
  const roundTrip = await verifyDocumentRoundTrip(documentUrn, markdown);
  handoff.datahub = {
    saved: true,
    documentUrn,
    roundTrip,
    syncedCatalogDigest: roundTrip.writtenDigest,
    syncedLocalDigest: roundTrip.writtenDigest,
  };
  saveHandoff(handoff);
  check("save", "the document was created and reads back byte for byte", roundTrip.matches, `${documentUrn} @ ${roundTrip.writtenDigest}`);

  say("\n2/6  reconcile — nothing has moved");
  const first = record("baseline", await reconcileHandoff(handoff));
  check("baseline", "the runbook and its document are in sync", first.status === "in-sync", first.detail);

  say("\n3/6  a steward edits the document inside DataHub");
  const edited = `${markdown}\n\n${STEWARD_EDIT_1}`;
  const edit1 = await datahubGraphQL<{ updateDocumentContents: boolean }>(UPDATE_DOCUMENT_CONTENTS, {
    input: { urn: documentUrn, contents: { text: edited } },
  });
  check(
    "steward-edit",
    "the edit landed through DataHub's own mutation",
    Boolean(edit1.data?.updateDocumentContents),
    edit1.errors?.map((e) => e.message).join("; ") || `catalog now at ${documentDigest(edited.trimEnd())}`
  );

  say("\n4/6  reconcile — the catalog wins");
  const pulled = record("catalog-edit", await reconcileHandoff(handoff));
  check("pull", "the edit is detected as catalog-ahead and pulled", pulled.status === "catalog-ahead" && pulled.action === "pulled", pulled.detail);
  check(
    "pull",
    "the steward's words are on the handoff verbatim",
    Boolean(handoff.datahub?.pulledBody?.includes(STEWARD_EDIT_1)),
    handoff.datahub?.pulledBody ? `pulled ${handoff.datahub.pulledBody.length} chars at ${handoff.datahub.pulledAt}` : "nothing pulled"
  );
  const settled = record("after-pull", await reconcileHandoff(handoff));
  check("pull", "a second reconcile has nothing left to do", settled.status === "in-sync", settled.detail);

  say("\n5/6  fold the steward's edit in, then push compare-and-set");
  const blocked = record("blocked-push", await pushHandoffDocument(handoff));
  check(
    "push",
    "a push before the pulled edit is folded in is refused",
    blocked.action === "refused",
    blocked.detail
  );
  handoff.steps[1].tips =
    "If the total looks short, ping Priya Patel — she owns the close now. Reconcile against the ledger before " +
    "quoting anything (steward's note, folded in from the catalog copy).";
  markPullFolded(handoff);
  const localAhead = record("local-edit", await reconcileHandoff(handoff));
  check("push", "the folded runbook is detected as local-ahead", localAhead.status === "local-ahead", localAhead.detail);
  const pushed = record("push", await pushHandoffDocument(handoff));
  check("push", "the push goes through and reads back byte for byte", pushed.action === "pushed", pushed.detail);
  const pushedDoc = await readDocument(documentUrn);
  check(
    "push",
    "the pushed body carries the folded steward guidance",
    Boolean(pushedDoc?.content.includes("steward's note, folded in")),
    pushedDoc ? `catalog at ${documentDigest(pushedDoc.content.trimEnd())}` : "document unreadable"
  );

  say("\n6/6  both sides move — the push must be refused");
  const conflictBody = `${handoffToMarkdown(handoff)}\n\n${STEWARD_EDIT_2}`;
  await datahubGraphQL(UPDATE_DOCUMENT_CONTENTS, { input: { urn: documentUrn, contents: { text: conflictBody } } });
  handoff.steps[0].tips = "Check the provider dashboard first when success_rate dips.";
  saveHandoff(handoff);
  const conflict = record("conflict", await reconcileHandoff(handoff));
  check("conflict", "both edits together are reported as a conflict, nothing auto-resolved", conflict.status === "conflict" && conflict.action === "none", conflict.detail);
  const refused = record("refused-push", await pushHandoffDocument(handoff));
  check("conflict", "the push is refused", refused.action === "refused", refused.detail);
  const after = await readDocument(documentUrn);
  check(
    "conflict",
    "the steward's edit is still in the catalog, read back after the refusal",
    Boolean(after?.content.includes(STEWARD_EDIT_2)),
    after ? `catalog still at ${documentDigest(after.content.trimEnd())}, steward's note intact` : "document unreadable"
  );

  // Cleanup: the drill's runbook and document are temporary.
  await datahubGraphQL(DELETE_DOCUMENT, { urn: documentUrn });
  deleteHandoff(handoff.id);
  say("    · cleaned up the drill's runbook and document");

  finish(started, documentUrn);
}

function finish(started: string, documentUrn?: string): void {
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.length - passed;
  const receipts = {
    startedAt: started,
    finishedAt: new Date().toISOString(),
    gms: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
    documentUrn,
    method:
      "A runbook was saved as a DataHub Document, edited inside DataHub through updateDocumentContents (the same " +
      "mutation the UI editor lands on), and reconciled by three-way content digest. The catalog edit was pulled " +
      "verbatim; the local correction was pushed compare-and-set; and with both sides moved, the push was refused " +
      "and the steward's edit read back intact. The document and runbook were temporary and removed.",
    checks,
    summary: { total: checks.length, passed, failed },
    syncs,
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(receipts, null, 2) + "\n");
  if (json) console.log(JSON.stringify({ receipts: OUT, summary: receipts.summary }));
  else console.log(`\n${passed}/${checks.length} checks passed${failed ? `, ${failed} FAILED` : ""}.\nReceipts written to ${path.relative(process.cwd(), OUT)}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
