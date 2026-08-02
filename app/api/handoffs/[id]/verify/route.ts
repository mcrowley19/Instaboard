import { getHandoff } from "@/lib/handoff-store";
import { validateRunbook } from "@/lib/sweep";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Re-validate a runbook against live DataHub.
 *
 * Detection is deterministic. It diffs the schema and reads health, with no LLM
 * anywhere in it, so a "broken" verdict is something an on-call engineer can confirm in the
 * DataHub UI inside ten seconds. Every claim the runbook makes is pinned to the version of
 * the catalog aspect it was validated against, so the verdict is reproducible rather than
 * asserted.
 *
 * This runs the same `validateRunbook` the unattended sweep runs, rather than a parallel
 * path — pressing Validate and running the cron job have to do the same thing, or the demo
 * shows something the nightly pass doesn't. That covers the write-back at every level: the
 * drift-note Document, the runbook-validity assertion and structured properties, the
 * `Stale Runbook` tag, an Incident assigned to whoever owns the dataset today, and a
 * proposed correction for a human to approve.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const handoff = getHandoff(id);
  if (!handoff) return Response.json({ error: "Handoff not found" }, { status: 404 });

  try {
    const { row, report } = await validateRunbook(handoff);
    return Response.json({
      report,
      claims: row.claims,
      writtenBack: Boolean(row.receipt?.written),
      receipt: row.receipt,
      native: row.native,
      structured: row.structured,
      proposal: row.proposal,
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
