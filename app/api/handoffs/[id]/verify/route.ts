import { detectDecay, writeBackDecay, type WriteBackReceipt } from "@/lib/decay";
import { getHandoff, saveHandoff } from "@/lib/handoff-store";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Re-validate a runbook against live DataHub.
 *
 * Detection is deterministic — a schema diff plus a health read, no LLM — so a
 * "broken" verdict is a fact a judge (or an on-call engineer) can confirm in
 * the DataHub UI in ten seconds. Findings are persisted onto the handoff and,
 * when anything has drifted, written back to the catalog so the staleness is
 * visible to whoever finds the runbook there rather than only in this app.
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
    if (report.severity !== "ok") {
      receipt = await writeBackDecay(handoff, report);
    }

    return Response.json({ report, writtenBack: Boolean(receipt?.written), receipt });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
