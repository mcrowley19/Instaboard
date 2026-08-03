/**
 * The loop, on a real catalog, from a link.
 *
 * `/api/demo/drift` reads a catalog and computes a report. It deliberately never
 * writes, which makes it safe to publish and leaves out the half of this project
 * that is the point: DataHub carries the state. An incident fires on the dataset
 * a broken runbook reads. A tag lands on it. A custom assertion goes FAILING.
 * Repair the catalog and all three come back down. Until now the only way to see
 * that was `git clone` and `npm run prove`.
 *
 * So this endpoint runs it. Break a column in a real DataHub, catch it, write
 * the state, read every write back, then put the column back and watch the state
 * retract — with the URNs and deep links, so nothing has to be taken on trust.
 *
 * ## What keeps this safe to publish
 *
 * It writes to a real catalog, so every guard here is load-bearing:
 *
 *   • **Off unless switched on.** `DEMO_WRITEBACK_ENABLED=true` and nothing
 *     else turns it on. A deployment that has not opted in gets 503.
 *   • **Only the demo runbook's own datasets.** The URNs come from
 *     `demoRunbook()`, not from the request. There is no parameter that selects
 *     an entity, so there is nothing to point somewhere else.
 *   • **One at a time.** A mutex serialises the whole fire/repair cycle, because
 *     two visitors interleaving an inject and a restore would produce a report
 *     neither of them caused.
 *   • **Always restores.** The injected drift is reverted in a `finally`, so a
 *     failure part-way through does not leave the catalog broken for the next
 *     visitor. `repair` is also idempotent and safe to call at any time.
 *
 * This is meant for a disposable DataHub. Do not point it at a catalog anyone
 * relies on: it drops a column, briefly, on purpose.
 */

import { diffAgainstCatalog, snapshotEntity, writeBackDecay } from "@/lib/decay";
import { injectDrift, revertDrift, type PlannedDrift } from "@/lib/drift-injection";
import { demoRunbook } from "@/lib/demo-drift";
import { gmsReachable } from "@/lib/datahub-graphql";
import { isDemoMode } from "@/lib/mcp";
import { readStaleTag, resolveIncidentsFor, retractStaleTags, writeBackNative } from "@/lib/native-writeback";
import { readAssertionStatus, writeStructuredState } from "@/lib/structured-state";
import { CORS_HEADERS } from "@/lib/cors";
import type { EntitySnapshot, Handoff } from "@/lib/types";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";
export const maxDuration = 300;

const enabled = () => (process.env.DEMO_WRITEBACK_ENABLED || "").toLowerCase() === "true";

/** Where a judge goes to see the write with their own eyes. */
const frontendUrl = () =>
  process.env.DATAHUB_FRONTEND_URL || (process.env.DATAHUB_GMS_URL || "http://localhost:8080").replace(":8080", ":9002");

const datasetLink = (urn: string) => `${frontendUrl()}/dataset/${encodeURIComponent(urn)}`;

/**
 * One column, on the dataset the runbook's second step selects by name in its
 * SQL. Dropping it is what makes the runbook wrong rather than merely out of
 * date, which is the case that earns an incident.
 */
function plannedDrift(runbook: Handoff): PlannedDrift {
  const step = runbook.steps[1];
  return {
    id: `hosted-demo-${runbook.id}`,
    kind: "column-dropped",
    urn: step.urn!,
    subject: "net_amount_usd",
    runbookId: runbook.id,
    expect: "column-missing",
    decoy: false,
    undo: {},
    detail: `Drop \`net_amount_usd\` from the dataset step 2 of "${runbook.title}" reads.`,
  };
}

/* ── One at a time ────────────────────────────────────────────────────── */

const g = globalThis as unknown as { __writebackLock?: Promise<unknown> };

/** Serialise the cycle: an inject interleaved with a restore reports fiction. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = g.__writebackLock ?? Promise.resolve();
  let release!: () => void;
  g.__writebackLock = new Promise<void>((resolve) => (release = resolve));
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function snapshotAll(urns: string[]): Promise<Record<string, EntitySnapshot>> {
  const snapshots = await Promise.all(urns.map(snapshotEntity));
  return Object.fromEntries(snapshots.map((s) => [s.urn, s]));
}

/**
 * The runbook carries a *fixture* baseline — what its author saw in the demo
 * catalog. Diffing a live catalog against that would report every difference
 * between the two as drift, before anything was broken, and the visitor would
 * see findings nobody caused.
 *
 * So the baseline is captured off the live catalog immediately before the break,
 * which is also what actually happens when somebody records a runbook: this is
 * the state at record time. `fire` stashes it so `repair` can diff against the
 * same baseline rather than against the catalog it just fixed — diffing a
 * restored catalog against a snapshot of itself is a check that cannot fail, and
 * a check that cannot fail proves nothing.
 */
const baselines = globalThis as unknown as { __writebackBaseline?: Record<string, EntitySnapshot> };

const withBaseline = (runbook: Handoff, snapshots: Record<string, EntitySnapshot>): Handoff => ({
  ...runbook,
  snapshots,
});

/* ── Handlers ─────────────────────────────────────────────────────────── */

export async function GET(): Promise<Response> {
  const runbook = demoRunbook();
  const available = enabled() && !isDemoMode() && (await gmsReachable());
  return Response.json(
    {
      available,
      ...(available ? {} : { why: unavailableReason() }),
      runbook: { id: runbook.id, title: runbook.title },
      /* Named up front so the page can say what it is about to do to the catalog. */
      willChange: plannedDrift(runbook).detail,
      datasets: runbook.steps
        .map((s) => s.urn)
        .filter((u): u is string => Boolean(u))
        .map((urn) => ({ urn, url: datasetLink(urn) })),
    },
    { headers: CORS_HEADERS }
  );
}

function unavailableReason(): string {
  if (isDemoMode()) return "This deployment runs on the fixture catalog, so there is nothing to write to.";
  if (!enabled()) return "Write-back is off. Set DEMO_WRITEBACK_ENABLED=true on a DataHub you can afford to break.";
  return "No DataHub is answering at DATAHUB_GMS_URL.";
}

export async function POST(request: Request): Promise<Response> {
  let action = "";
  try {
    action = String(((await request.json()) as { action?: unknown }).action ?? "");
  } catch {
    /* handled below as an unknown action */
  }
  if (action !== "fire" && action !== "repair") {
    return Response.json({ error: "action must be 'fire' or 'repair'" }, { status: 400, headers: CORS_HEADERS });
  }

  if (isDemoMode() || !enabled() || !(await gmsReachable())) {
    return Response.json({ error: unavailableReason() }, { status: 503, headers: CORS_HEADERS });
  }

  const runbook = demoRunbook();
  const urns = [...new Set(runbook.steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];

  return exclusive(async () => {
    const started = Date.now();
    return action === "fire"
      ? Response.json(await fire(runbook, urns, started), { headers: CORS_HEADERS })
      : Response.json(await repair(runbook, urns, started), { headers: CORS_HEADERS });
  });
}

/**
 * Break the catalog, catch it, write the state, and read every write back.
 *
 * The drift is reverted before returning. What the visitor is looking at
 * afterwards is a catalog holding *the consequences* — incident, tag, failing
 * assertion — with the cause already undone, which is exactly the state a
 * nightly sweep leaves behind at 3am. `repair` is what clears it.
 */
async function fire(runbook: Handoff, urns: string[], started: number) {
  const drift = plannedDrift(runbook);
  let injected = false;

  // Record time: what the catalog held before anything was touched.
  const baseline = await snapshotAll(urns);
  baselines.__writebackBaseline = baseline;
  const recorded = withBaseline(runbook, baseline);

  try {
    injected = await injectDrift(drift);
    if (!injected) {
      return {
        ok: false,
        error:
          `Could not drop \`${drift.subject}\` — the dataset or the column is not in this catalog. ` +
          `Seed it with \`npm run seed\` first.`,
      };
    }

    const live = await snapshotAll(urns);
    const report = diffAgainstCatalog(recorded, live);

    // Write the three surfaces, in the order `npm run prove` does.
    const document = await writeBackDecay(recorded, report);
    const native = await writeBackNative(recorded, report, document.documentUrn, live);
    const structured = await writeStructuredState(recorded, report);

    // …then ask DataHub for each of them back. A write nobody read is a claim.
    // The datasets that drifted should now carry a FAILING assertion.
    const readBack = await readEverythingBack(recorded, urns, "FAILURE");

    return {
      ok: true,
      action: "fire",
      broke: drift.detail,
      verdict: report.verdict,
      severity: report.severity,
      findings: report.findings.map((f) => ({ kind: f.kind, detail: f.detail, severity: f.severity, urn: f.urn })),
      wrote: {
        document: {
          written: document.written,
          urn: document.documentUrn,
          /* The read-back that used to be impossible — see lib/document-readback.ts. */
          roundTrip: document.roundTrip,
        },
        incidents: native.incidents,
        tagged: native.tagged,
        assertions: structured.assertions,
        // The document write's own error belongs here. It was missing, so a
        // failed `save_document` showed up as an absent URN next to a green
        // incident and tag — three writes reported as if all three had landed.
        errors: [
          ...(document.error ? [`save_document: ${document.error}`] : []),
          ...native.errors,
          ...structured.errors,
        ],
      },
      readBack,
      links: urns.map((urn) => ({ urn, url: datasetLink(urn) })),
      tookMs: Date.now() - started,
    };
  } finally {
    // Always. A visitor who closes the tab mid-request must not leave the next
    // one a catalog with a column missing.
    if (injected) await revertDrift(drift);
  }
}

/**
 * Put it back: validate clean, resolve the incident, retract the tag, return the
 * assertion to passing — and read all three back again to show they went.
 */
async function repair(runbook: Handoff, urns: string[], started: number) {
  const drift = plannedDrift(runbook);
  // Idempotent: reverting an already-reverted drift is a no-op, and calling
  // repair twice must not be an error a visitor has to understand.
  await revertDrift(drift);

  const live = await snapshotAll(urns);
  // Against the baseline `fire` captured, so "clean" means "matches what the
  // runbook was recorded against" and not merely "matches itself". Absent one —
  // repair called first, or a different instance served it — fall back to the
  // current state, and say so in the response rather than implying a comparison
  // that did not happen.
  const baseline = baselines.__writebackBaseline;
  const recorded = withBaseline(runbook, baseline ?? live);
  const report = diffAgainstCatalog(recorded, live);

  // Order and guard both matter, and both are taken from `lib/sweep.ts` rather
  // than reinvented here.
  //
  // Structured state goes first, so `retractStaleTags` reads *this* run's
  // "validated" out of the status property instead of the previous run's
  // "stale" and declines to retract its own repair.
  //
  // And retraction only happens on a clean report. Taking the tag down while the
  // runbook is still stale for some *other* reason — pre-existing drift on one of
  // these datasets, which the benchmark has hit before — would retract a warning
  // that is still earned. Repair is allowed to clear what it caused, not to
  // declare everything fine.
  const structured = await writeStructuredState(recorded, report);
  const clean = report.severity === "ok" && structured.attempted;
  const resolved = clean ? await resolveIncidentsFor(recorded, urns) : [];
  const retraction = clean ? await retractStaleTags(recorded, urns) : null;
  const readBack = await readEverythingBack(recorded, urns, clean ? "SUCCESS" : undefined);

  return {
    ok: true,
    action: "repair",
    restored: `\`${drift.subject}\` is back on ${drift.urn.split(",")[1] ?? drift.urn}.`,
    /* False when there was no recorded baseline to compare against — see above. */
    comparedToRecordTime: Boolean(baseline),
    verdict: report.verdict,
    severity: report.severity,
    findings: report.findings.map((f) => ({ kind: f.kind, detail: f.detail, severity: f.severity, urn: f.urn })),
    /* False when the runbook did not come back clean, so nothing was retracted. */
    retractionEarned: clean,
    retracted: {
      incidents: resolved,
      untagged: retraction?.untagged ?? [],
      /* Datasets that kept the tag because another runbook is still stale on them. */
      kept: retraction?.kept ?? [],
      assertions: structured.assertions,
      errors: [...(retraction?.errors ?? []), ...structured.errors],
    },
    readBack,
    links: urns.map((urn) => ({ urn, url: datasetLink(urn) })),
    tookMs: Date.now() - started,
  };
}

/**
 * What the catalog says right now, read fresh off DataHub rather than inferred
 * from what we just sent it. This is the difference between "we called the API"
 * and "the catalog holds this".
 */
async function readEverythingBack(runbook: Handoff, urns: string[], expect?: "FAILURE" | "SUCCESS") {
  return Promise.all(
    urns.map(async (urn) => ({
      urn,
      url: datasetLink(urn),
      staleTag: await readStaleTag(urn),
      assertion: await assertionSettlingOn(runbook.id, urn, expect),
    }))
  );
}

/**
 * Read the assertion back, giving its result a moment to arrive.
 *
 * Assertion *results* are timeseries data and land in their own index a beat
 * after the upsert returns. Reading immediately caught the previous run's
 * verdict: the receipt said one assertion was now FAILING and the read-back
 * underneath it said SUCCESS, which is the single most damaging thing this panel
 * could show — the row that exists to prove the write is the row contradicting
 * it.
 *
 * So poll briefly for the result we just wrote. Bounded, and it returns whatever
 * the catalog says when the budget runs out rather than pretending: a
 * disagreement that survives ten seconds is a real disagreement and should be
 * visible.
 */
async function assertionSettlingOn(
  runbookId: string,
  urn: string,
  expect?: "FAILURE" | "SUCCESS",
  budgetMs = 20_000
) {
  const deadline = Date.now() + budgetMs;
  let latest = await readAssertionStatus(runbookId, urn);
  while (expect && latest && latest.result !== expect && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    latest = await readAssertionStatus(runbookId, urn);
  }
  return latest;
}
