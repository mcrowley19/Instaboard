import { detectDecay, decayToMarkdown } from "@/lib/decay";
import { getHandoff, saveHandoff } from "@/lib/handoff-store";
import { callDataHubTool } from "@/lib/mcp";

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

    // Only write back when there's something worth telling the catalog.
    let written = false;
    if (report.severity !== "ok") {
      const doc = await callDataHubTool("save_document", {
        document_type: "Note",
        title: `Stale runbook: ${handoff.title}`,
        content: decayToMarkdown(handoff, report),
        topics: ["onboarding", "handoff", "validation"],
        related_assets: [...new Set(report.findings.map((f) => f.urn))].slice(0, 10),
      });
      written = !doc.isError;
    }

    return Response.json({ report, writtenBack: written });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
