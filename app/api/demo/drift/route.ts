/**
 * The interactive half of the hosted demo: break the catalog, get a real report.
 *
 * Stateless by design. The mutations arrive in the request, are applied to a
 * fresh copy of the current catalog state, and the report is computed and thrown
 * away — so two visitors cannot see each other's catalog, and there is nothing
 * to reset. It also means this works on a serverless host with no storage.
 *
 * Where "the current catalog state" comes from depends on the deployment. With a
 * DataHub configured, the datasets are read out of it during the request and the
 * response carries a `live` receipt saying which catalog, when, and what came
 * back. Without one, the committed fixture baseline is used and `fixture: true`
 * says so. The engine is the same either way — `diffAgainstCatalog`, the
 * function the live sweep calls — and there is no demo branch inside it.
 *
 * It never writes. The visitor's breaking changes exist only in the snapshot
 * this request read, so a public instance cannot be damaged by the people
 * using it. Write-back against a real catalog is `npm run prove`, whose receipts
 * CI re-derives on every push.
 */

import { decayToMarkdown } from "@/lib/decay";
import { DEMO_MUTATIONS, revalidateDemo } from "@/lib/demo-drift";
import { liveDemoAvailable, revalidateLive, type LiveDemoResult } from "@/lib/live-demo";
import { CORS_HEADERS } from "@/lib/cors";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";

/** The changes on offer, so the buttons come from the same list the engine uses. */
export async function GET(): Promise<Response> {
  return Response.json(
    {
      mutations: DEMO_MUTATIONS.map((m) => ({
        id: m.id,
        label: m.label,
        detail: m.detail,
        affectsStep: m.affectsStep,
      })),
      /* So the page can say up front whether it is about to read a real catalog. */
      live: await liveDemoAvailable(),
    },
    { headers: CORS_HEADERS }
  );
}

export async function POST(request: Request): Promise<Response> {
  let ids: string[] = [];
  try {
    const body = (await request.json()) as { mutations?: unknown };
    if (Array.isArray(body.mutations)) ids = body.mutations.filter((m): m is string => typeof m === "string");
  } catch {
    // An unparseable body validates the untouched catalog, which is a sensible
    // thing to return rather than an error nobody can act on.
  }

  /*
   * Where the current side of the comparison comes from.
   *
   * If this deployment has a DataHub, the three datasets are read out of it
   * during this request and the visitor's changes are applied to what came
   * back, in memory. If it does not, the committed fixture baseline is used.
   * Either way the response says which, because a reader who cannot tell a live
   * read from a replay has no reason to believe either.
   */
  const live = await liveDemoAvailable();
  const result = live ? await revalidateLive(ids) : revalidateDemo(ids);
  const { report, runbook, applied } = result;

  return Response.json(
    {
      applied,
      verdict: report.verdict,
      severity: report.severity,
      coverage: report.coverage,
      findings: report.findings,
      claims: report.claims,
      verdicts: report.verdicts,
      steps: runbook.steps.map((s) => ({ title: s.title, urn: s.urn })),
      /* The note this would write into DataHub, rendered by the same function. */
      note: decayToMarkdown(runbook, report),
      checkedAt: report.checkedAt,
      fixture: !live,
      /* Present only on a live read: which catalog, when, and what came back. */
      ...(live ? { live: (result as LiveDemoResult).live } : {}),
    },
    { headers: CORS_HEADERS }
  );
}
