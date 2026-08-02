import { detectDecay, writeBackDecay, type WriteBackReceipt } from "@/lib/decay";
import { writeBackNative, type NativeWriteBackReceipt } from "@/lib/native-writeback";
import { getHandoff, saveHandoff } from "@/lib/handoff-store";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Re-validate a runbook against live DataHub.
 *
 * Detection is deterministic. It diffs the schema and reads health, with no LLM
 * anywhere in it, so a "broken" verdict is something an on-call engineer can
 * confirm in the DataHub UI inside ten seconds. Findings are persisted onto the handoff and,
 * when anything has drifted, written back to the catalog so the staleness is
 * visible to whoever finds the runbook there rather than only in this app.
 *
 * Write-back happens at two levels: a drift note Document (the full report), and
 * DataHub's native primitives, meaning a `Stale Runbook` tag on every drifted
 * dataset plus a real Incident on any dataset where a step would now fail. That
 * second level puts the finding in front of a data team without anyone having to
 * open a document.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const handoff = getHandoff(id);
  if (!handoff) return Response.json({ error: "Handoff not found" }, { status: 404 });

  try {
    const report = await detectDecay(handoff);
    handoff.decay = report;
    saveHandoff(handoff);

    // Only write back when there's something worth telling the catalog. The
    // receipt carries the document URN DataHub reports, so the write-back is
    // verifiable in the catalog rather than just claimed by this response.
    let receipt: WriteBackReceipt | null = null;
    let native: NativeWriteBackReceipt | null = null;
    if (report.severity !== "ok") {
      receipt = await writeBackDecay(handoff, report);
      native = await writeBackNative(handoff, report, receipt.documentUrn);
    }

    return Response.json({ report, writtenBack: Boolean(receipt?.written), receipt, native });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
