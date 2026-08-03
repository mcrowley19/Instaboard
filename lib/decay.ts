import { callDataHubTool, isDemoMode } from "./mcp";
import { datahubGraphQL } from "./datahub-graphql";
import {
  chainLine,
  coverageOf,
  displayName,
  extractClaims,
  humanOwners,
  ownersNamedIn,
  schemaObservable,
  stepReferences,
  verdictOf,
  verifyClaims,
  versionOf,
} from "./provenance";
import type { ClaimKind, DecayFinding, DecayReport, EntitySnapshot, Handoff, RunbookClaim } from "./types";

/**
 * Runbook decay detection.
 *
 * Captured knowledge rots. A handoff written in July says "use net_amount_usd
 * and ping Mike about the dbt job"; by December the column may be renamed, the
 * table deprecated, and Mike may have left. A stale runbook is worse than no
 * runbook — the successor follows it confidently into a wall.
 *
 * So instaboard snapshots the catalog facts each step depends on at record
 * time, then re-checks them against live DataHub on demand. Detection is
 * entirely deterministic — a schema diff and a health read, no LLM guessing —
 * so a "BROKEN" verdict is something you can verify by hand in the DataHub UI.
 */

/* ── Snapshotting ─────────────────────────────────────────────────────── */

function parseToolJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Live MCP servers sometimes wrap JSON in prose — grab the outermost object.
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** Walk an arbitrary JSON tree collecting every value found under `key`. */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

function flatStrings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(...flatStrings(v));
    else if (v && typeof v === "object") {
      const named = (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).urn;
      if (typeof named === "string") out.push(named);
    }
  }
  return out;
}

function countByStatus(node: unknown, key: string, status: string): number {
  const groups = collect(node, key);
  let n = 0;
  for (const group of groups) {
    const items = Array.isArray(group) ? group : [group];
    for (const item of items) {
      if (
        item &&
        typeof item === "object" &&
        String((item as Record<string, unknown>).status ?? "").toLowerCase() === status.toLowerCase()
      )
        n++;
    }
  }
  return n;
}

/**
 * Pull the identities of the people and groups who own an entity.
 *
 * Ownership nests differently per shape: the demo fixture inlines strings, live
 * GMS nests `{owner: {urn, properties: {displayName}}, ownershipType: {...}}`.
 * We read `ownership.owners[].owner` specifically rather than deep-scanning,
 * because a deep scan also sweeps up ownership *type* labels ("Data Steward")
 * and the owners of attached glossary terms. Neither of those owns this dataset,
 * and both would produce false "owner changed" findings.
 *
 * `displayName` is the identity that matters: a runbook step says "ping Priya
 * Sharma", never "ping urn:li:corpuser:b2fd91.patrick1@example.com". Without it,
 * owner drift can never be detected against a live catalog.
 */
function ownerIdentities(parsed: unknown): { identities: string[]; urns: string[] } {
  const out: string[] = [];
  // Kept separately from the display identities: assigning a DataHub incident to
  // the current owner needs the actual corpuser URN, and "Priya Sharma" is not one.
  const urns: string[] = [];

  // `get_entities` returns a bare array (live GMS) or `{entities: [...]}` (demo
  // fixture). Read ownership off the entity root only. A deep scan also picks up
  // the owners of glossary terms attached to it, who don't own the dataset, plus
  // ownership type labels like "Data Steward", which aren't people. Both produce
  // false "owner changed" findings.
  const root = parsed as Record<string, unknown> | unknown[];
  const wrapped = !Array.isArray(root) && Array.isArray((root as Record<string, unknown>)?.entities);
  const entities = wrapped
    ? ((root as Record<string, unknown>).entities as unknown[])
    : Array.isArray(root)
      ? root
      : [root];
  for (const entity of entities) {
    if (!entity || typeof entity !== "object") continue;
    const e = entity as Record<string, unknown>;
    const ownership = e.ownership as Record<string, unknown> | undefined;
    // Live GMS: {ownership: {owners: [...]}}. Demo fixture: {owners: [...]}.
    const list = (ownership?.owners ?? e.owners) as unknown;
    for (const entry of Array.isArray(list) ? list : list ? [list] : []) {
      if (typeof entry === "string") {
        out.push(entry);
        if (entry.startsWith("urn:li:corp")) urns.push(entry);
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const raw: unknown = (entry as Record<string, unknown>).owner ?? entry;
      // Some shapes inline the owner as a bare URN string rather than an object.
      if (typeof raw === "string") {
        out.push(raw);
        if (raw.startsWith("urn:li:corp")) urns.push(raw);
        continue;
      }
      const owner = raw as Record<string, unknown>;
      const props = (owner.properties ?? owner.info ?? {}) as Record<string, unknown>;
      for (const candidate of [props.displayName, owner.username, owner.name, props.email, owner.urn]) {
        if (typeof candidate === "string" && candidate) out.push(candidate);
      }
      if (typeof owner.urn === "string" && owner.urn.startsWith("urn:li:corp")) urns.push(owner.urn);
    }
  }
  return { identities: [...new Set(out)], urns: [...new Set(urns)] };
}

/**
 * Live DataHub inlines a summary `health` array on entities
 * (`{type: "ASSERTIONS"|"INCIDENTS", status: "FAIL", causes: [urns]}`) instead
 * of the per-assertion lists the demo fixture uses. Read both shapes.
 */
function applyHealthSummary(parsed: unknown, snapshot: EntitySnapshot): void {
  const entries = collect(parsed, "health").flatMap((h) => (Array.isArray(h) ? h : [h]));
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (String(e.status ?? "").toUpperCase() !== "FAIL") continue;
    // `causes` is sometimes a list of assertion URNs and sometimes a single
    // marker string ("ACTIVE_INCIDENTS"); the `message` carries the real count
    // ("1 active incident", "2 of 3 assertions are failing").
    const causes = Array.isArray(e.causes) ? e.causes.filter((c): c is string => typeof c === "string") : [];
    // Discount the assertions this tool reports itself (see discountSelfWrittenState).
    const urnCauses = causes.filter((c) => c.startsWith("urn:li:") && !isSelfWritten(c));
    const fromMessage = Number(String(e.message ?? "").match(/(\d+)/)?.[1] ?? 0);
    const count = causes.some((c) => c.startsWith("urn:li:")) ? urnCauses.length : fromMessage || 1;
    const type = String(e.type ?? "").toUpperCase();
    if (type === "ASSERTIONS") snapshot.failingAssertions = Math.max(snapshot.failingAssertions, count);
    if (type === "INCIDENTS") snapshot.openIncidents = Math.max(snapshot.openIncidents, count);
  }
}

/** Assertions instaboard reports itself carry a recognisable URN prefix. */
export const SELF_ASSERTION_PREFIX = "urn:li:assertion:instaboard-";

function isSelfWritten(urn: string): boolean {
  return urn.startsWith(SELF_ASSERTION_PREFIX);
}

/**
 * Don't let the tool's own write-back read back as new drift.
 *
 * When a sweep finds a broken runbook it raises an Incident on the dataset and
 * reports a FAILING assertion against it. The next sweep then sees an open
 * incident and a failing assertion that weren't there at record time and reports
 * both as fresh drift. instaboard flagging instaboard, every night, for ever. So
 * discount the state this tool wrote: incidents titled "Stale runbook: <runbook>"
 * and assertions under `urn:li:assertion:instaboard-`.
 *
 * This has to go over GraphQL. The entity's inlined health summary reports
 * `causes: ["ACTIVE_INCIDENTS"]` rather than the incident URNs, and reading an
 * incident by URN through `get_entities` returns "exists but no data could be
 * retrieved", because incidents are not readable over MCP today. Demo mode has no
 * GMS behind the fixture, so the call fails fast and the counts are left alone.
 */
export async function discountSelfWrittenState(snapshot: EntitySnapshot): Promise<void> {
  // The same read answers a second question: how many assertions exist on this
  // dataset at all. Without it, "0 failing assertions" on an unmonitored table
  // reads identically to a table that is genuinely passing its checks, and the
  // sweep hands back a clean bill of health nobody actually verified. So this
  // runs even when the counters are zero — that is precisely the case it decides.
  //
  // Demo mode answers from a fixture and has no GMS behind it. Querying a real
  // GMS that happens to be running on the same machine would mix a live catalog
  // into fixture-derived state, so the fixture's own assertion list is used there.
  if (isDemoMode()) return;

  const res = await datahubGraphQL<{
    dataset: {
      incidents: { incidents: { title: string }[] } | null;
      assertions: { assertions: { urn: string; runEvents: { failed: number } | null }[] } | null;
    } | null;
  }>(
    `query($urn: String!) {
       dataset(urn: $urn) {
         incidents(state: ACTIVE, start: 0, count: 50) { incidents { title } }
         assertions(start: 0, count: 50) { assertions { urn runEvents(limit: 1) { failed } } }
       }
     }`,
    { urn: snapshot.urn }
  );

  const open = res.data?.dataset?.incidents?.incidents;
  if (open) {
    const ours = open.filter((i) => /^stale runbook:/i.test(i.title ?? "")).length;
    if (ours > 0) snapshot.openIncidents = Math.max(0, snapshot.openIncidents - ours);
  }

  const assertions = res.data?.dataset?.assertions?.assertions;
  if (assertions) {
    const ours = assertions.filter((a) => isSelfWritten(a.urn) && (a.runEvents?.failed ?? 0) > 0).length;
    if (ours > 0) snapshot.failingAssertions = Math.max(0, snapshot.failingAssertions - ours);
    // Our own assertion doesn't count as somebody monitoring the table: it asserts
    // that a runbook still matches the catalog, not that the data is any good.
    snapshot.assertionCount = assertions.filter((a) => !isSelfWritten(a.urn)).length;
  }
}

/**
 * Read the catalog facts one entity's runbook steps depend on. Tolerant of
 * both the demo fixture shape and a live DataHub MCP server's response shape —
 * it deep-scans for the keys it needs rather than assuming a layout.
 */
export async function snapshotEntity(urn: string): Promise<EntitySnapshot> {
  const capturedAt = new Date().toISOString();
  const base: EntitySnapshot = {
    urn,
    exists: false,
    fields: [],
    owners: [],
    deprecated: false,
    openIncidents: 0,
    failingAssertions: 0,
    capturedAt,
  };
  // A missing entity still gets a version, so "it was there, now it isn't" is a
  // fingerprint change rather than a gap in the chain.
  base.version = versionOf(base);

  const entityResult = await callDataHubTool("get_entities", { urns: [urn] });
  if (entityResult.isError) return base;

  const parsed = parseToolJson(entityResult.content);
  if (!parsed) return base;

  const notFound =
    collect(parsed, "error").some((e) => typeof e === "string" && /not found|no such|does not exist/i.test(e)) ||
    /not found in catalog/i.test(entityResult.content);
  if (notFound) return base;

  const names = flatStrings(collect(parsed, "name"));
  const owners = ownerIdentities(parsed);
  // The deprecation note names the replacement dataset far more often than not,
  // which is what makes an automatic "point this step somewhere else" proposal
  // possible instead of just a warning.
  const note = collect(parsed, "deprecation")
    .map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>).note : undefined))
    .find((n): n is string => typeof n === "string" && n.trim().length > 0);
  const snapshot: EntitySnapshot = {
    ...base,
    exists: true,
    name: names[0],
    fields: [...new Set(flatStrings(collect(parsed, "fieldPath")))],
    owners: owners.identities,
    ownerUrns: owners.urns,
    deprecated: collect(parsed, "deprecated").some((d) => d === true || (d && typeof d === "object")),
    ...(note ? { deprecationNote: note.trim() } : {}),
    openIncidents: countByStatus(parsed, "incidents", "open") + countByStatus(parsed, "openIncidents", "open"),
    failingAssertions: countByStatus(parsed, "assertions", "fail"),
  };
  applyHealthSummary(parsed, snapshot);
  await discountSelfWrittenState(snapshot);

  // A dedicated health tool, where one exists, is authoritative over whatever
  // happens to be inlined on the entity. The live `mcp-server-datahub` has no
  // such tool, since it inlines `health` above, so this is the fixture's path.
  const health = await callDataHubTool("get_dataset_health", { urn });
  if (!health.isError) {
    const h = parseToolJson(health.content);
    if (h) {
      const dep = collect(h, "deprecated").find((d) => d !== null && d !== undefined);
      if (dep !== undefined) snapshot.deprecated = dep === true || (typeof dep === "object" && dep !== null);
      snapshot.openIncidents = countByStatus(h, "incidents", "open");
      snapshot.failingAssertions = countByStatus(h, "assertions", "fail");
      // How many assertions exist at all, not how many are failing: an empty list
      // means nothing is monitoring this table, which is a different fact from
      // "everything passes". See `healthObservable` in lib/provenance.ts.
      snapshot.assertionCount = collect(h, "assertions")
        .flatMap((a) => (Array.isArray(a) ? a : [a]))
        .filter(Boolean).length;
    }
  }

  // Fingerprint last, once every fact is in: the version has to cover the
  // snapshot as it will be stored, or a pin points at a state nobody can recompute.
  snapshot.version = versionOf(snapshot);
  return snapshot;
}

/** Snapshot every distinct entity a runbook's steps touch. */
export async function snapshotHandoff(steps: { urn?: string }[]): Promise<Record<string, EntitySnapshot>> {
  const urns = [...new Set(steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];
  const snapshots = await Promise.all(urns.map(snapshotEntity));
  return Object.fromEntries(snapshots.map((s) => [s.urn, s]));
}

/* ── Decay detection ──────────────────────────────────────────────────── */

const RANK: Record<DecayFinding["severity"], number> = { ok: 0, warning: 1, broken: 2 };

/**
 * Compare a runbook's recorded assumptions against live DataHub.
 *
 * With a snapshot we can diff (this column existed when the runbook was written
 * and is gone now). Without one — older handoffs, or the shipped sample — we
 * fall back to absolute checks against current state, which still catches
 * deprecated tables, open incidents, and stale owner references.
 */
export async function detectDecay(handoff: Handoff): Promise<DecayReport> {
  return (await detectDecayWithState(handoff)).report;
}

/**
 * Detection, plus the live snapshots it read.
 *
 * The remediator needs the current schema and owner list to work out *what to
 * put instead* — a dropped `net_amount_usd` can only be proposed as a rename to
 * `net_revenue_usd` if you can see the columns that exist now. Handing the same
 * read back out avoids a second pass over the catalog to recover it.
 */
export async function detectDecayWithState(
  handoff: Handoff
): Promise<{ report: DecayReport; live: Record<string, EntitySnapshot> }> {
  const live = await snapshotHandoff(handoff.steps);
  return { report: diffAgainstCatalog(handoff, live), live };
}

/**
 * The detection itself: a runbook, and the catalog as it stands, in — a report
 * out. Pure and synchronous, with every catalog read already done.
 *
 * Split out from the read so the same engine can be driven by something other
 * than a live DataHub — the interactive demo hands it a mutated fixture and gets
 * back a real report. Nothing about the verdict is special-cased for that path,
 * which is the only way a demo is worth showing.
 */
export function diffAgainstCatalog(handoff: Handoff, live: Record<string, EntitySnapshot>): DecayReport {
  const findings: DecayFinding[] = [];
  const recorded = handoff.snapshots ?? {};

  // The claim layer runs alongside detection rather than replacing it: detection
  // decides severity and what to say, claims record what was checked and against
  // which version of which aspect. Findings are joined back to their claim below.
  const claims = extractClaims(handoff, recorded, live);
  const verdicts = verifyClaims(claims, live);

  // Findings carry the id of the claim they broke, so a reader can walk from
  // "step 2 is wrong" back to the exact fact and the version it last held at.
  const claimIndex = new Map(claims.map((c) => [`${c.stepIndex}|${c.kind}|${c.subject.toLowerCase()}`, c.id]));
  const claimRef = (stepIndex: number, kind: ClaimKind, subject: string): { claimId?: string } => {
    const id = claimIndex.get(`${stepIndex}|${kind}|${subject.toLowerCase()}`);
    return id ? { claimId: id } : {};
  };

  handoff.steps.forEach((step, i) => {
    if (!step.urn) return;
    const now = live[step.urn];
    const then = recorded[step.urn];
    const where = { stepIndex: i, stepTitle: step.title, urn: step.urn };

    if (!now || !now.exists) {
      findings.push({
        ...where,
        ...claimRef(i, "entity-exists", step.urn),
        severity: "broken",
        kind: "entity-missing",
        detail: `\`${step.urn}\` is no longer in the catalog.`,
        remedy: "The entity was removed or renamed. Find its replacement and rewrite this step.",
      });
      return;
    }

    // Columns the step depends on that have disappeared since it was written.
    //
    // Only when the catalog still holds a schema for the entity. A dataset whose
    // schema failed to ingest returns an empty field list, and diffing against
    // that reports every column the runbook names as dropped — the loudest
    // possible false positive, on the least reliable input. It is recorded as a
    // coverage gap instead, which says "go and fix the ingestion".
    if (then?.exists && then.fields.length && schemaObservable(now)) {
      const removed = then.fields.filter((f) => !now.fields.includes(f));
      for (const field of removed) {
        if (!stepReferences(step, field)) continue;
        findings.push({
          ...where,
          ...claimRef(i, "column-exists", field),
          severity: "broken",
          kind: "column-missing",
          detail: `Column \`${field}\` is referenced by this step but no longer exists on ${now.name ?? step.urn}.`,
          remedy: `Check whether ${field} was renamed, and update this step's SQL and instructions.`,
        });
      }
    }

    if (now.deprecated && !then?.deprecated) {
      findings.push({
        ...where,
        ...claimRef(i, "not-deprecated", step.urn),
        severity: "broken",
        kind: "newly-deprecated",
        detail: `${now.name ?? step.urn} has been deprecated since this runbook was written.`,
        remedy: "Point this step at the replacement dataset named in DataHub.",
      });
    } else if (now.deprecated) {
      findings.push({
        ...where,
        ...claimRef(i, "not-deprecated", step.urn),
        severity: "warning",
        kind: "deprecated",
        detail: `${now.name ?? step.urn} is deprecated.`,
        remedy: "Point this step at the replacement dataset named in DataHub.",
      });
    }

    if (now.openIncidents > (then?.openIncidents ?? 0)) {
      findings.push({
        ...where,
        ...claimRef(i, "healthy", step.urn),
        severity: "warning",
        kind: "new-incident",
        detail: `${now.name ?? step.urn} has ${now.openIncidents} open incident${now.openIncidents === 1 ? "" : "s"}${
          then ? ` (was ${then.openIncidents} when recorded)` : ""
        }.`,
        remedy: "Read the incident before following this step — the data may currently be wrong.",
      });
    }

    if (now.failingAssertions > (then?.failingAssertions ?? 0)) {
      findings.push({
        ...where,
        ...claimRef(i, "healthy", step.urn),
        severity: "warning",
        kind: "failing-assertion",
        detail: `${now.name ?? step.urn} has ${now.failingAssertions} failing assertion${
          now.failingAssertions === 1 ? "" : "s"
        } (freshness/volume)${then ? ` (was ${then.failingAssertions} when recorded)` : ""}.`,
        remedy: "The table may be stale. Confirm it has loaded before trusting this step's output.",
      });
    }

    // "Ping Mike about the dbt job" — but Mike no longer owns the dataset.
    const namedThen = then?.exists ? ownersNamedIn(step, then.owners) : [];
    for (const owner of namedThen) {
      const display = displayName(owner);
      // Live DataHub renders owners as usernames ("mike.rodriguez"), snapshots
      // may hold display names ("Mike Rodriguez") — compare normalized.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const stillOwns = now.owners.some((o) => norm(o).includes(norm(display)));
      if (!stillOwns) {
        findings.push({
          ...where,
          ...claimRef(i, "owner-current", display),
          severity: "warning",
          kind: "owner-changed",
          detail: `This step says to contact ${display}, who no longer owns ${now.name ?? step.urn}.`,
          remedy: `Current owner${humanOwners(now.owners).length === 1 ? "" : "s"}: ${
            humanOwners(now.owners).join(", ") || "none listed"
          }.`,
        });
      }
    }
  });

  const severity = findings.reduce<DecayFinding["severity"]>(
    (worst, f) => (RANK[f.severity] > RANK[worst] ? f.severity : worst),
    "ok"
  );

  // Coverage runs over the same claims and verdicts, so "what we checked" and
  // "what we concluded" can never come apart.
  const coverage = coverageOf(handoff.steps, live, claims, verdicts);

  const report: DecayReport = {
    handoffId: handoff.id,
    checkedAt: new Date().toISOString(),
    severity,
    verdict: verdictOf(findings.length, coverage),
    coverage,
    stepsChecked: handoff.steps.filter((s) => s.urn).length,
    entitiesChecked: Object.keys(live).length,
    hadSnapshot: Object.keys(recorded).length > 0,
    findings,
    claims,
    verdicts,
    versions: Object.fromEntries(Object.entries(live).map(([urn, snap]) => [urn, snap.version ?? versionOf(snap)])),
  };

  return report;
}

/** Look a claim up by id — findings carry the id, consumers want the claim. */
export function claimById(report: DecayReport, claimId?: string): RunbookClaim | undefined {
  if (!claimId) return undefined;
  return report.claims?.find((c) => c.id === claimId);
}

/* ── Write-back with receipt ──────────────────────────────────────────── */

export interface WriteBackReceipt {
  written: boolean;
  /** URN of the document DataHub reports it created — the verifiable artifact. */
  documentUrn?: string;
  relatedAssets: string[];
  at: string;
  error?: string;
}

/**
 * Write a decay report into the catalog as a Note linked to the drifted
 * entities, and capture what DataHub says it created. The returned receipt
 * carries the document URN so the write-back is checkable, not just claimed.
 */
export async function writeBackDecay(handoff: Handoff, report: DecayReport): Promise<WriteBackReceipt> {
  const relatedAssets = [...new Set(report.findings.map((f) => f.urn))].slice(0, 10);
  const at = new Date().toISOString();

  const result = await callDataHubTool("save_document", {
    document_type: "Note",
    title: `Stale runbook: ${handoff.title}`,
    content: decayToMarkdown(handoff, report),
    topics: ["onboarding", "handoff", "validation"],
    related_assets: relatedAssets,
  });

  if (result.isError) {
    return { written: false, relatedAssets, at, error: result.content.slice(0, 300) };
  }

  const parsed = parseToolJson(result.content);
  const urns = flatStrings(collect(parsed, "urn")).filter((u) => u.startsWith("urn:li:document"));
  return { written: true, ...(urns[0] ? { documentUrn: urns[0] } : {}), relatedAssets, at };
}

/** Render a decay report as markdown for the DataHub write-back. */
export function decayToMarkdown(handoff: Handoff, report: DecayReport): string {
  const headline =
    report.severity === "ok"
      ? report.verdict === "INSUFFICIENT_DATA"
        ? `🔍 Nothing has drifted among the claims that could be checked — but ${
            report.coverage?.claimsUnvalidatable ?? 0
          } of ${report.coverage?.claimsTotal ?? 0} could not be checked at all. This is not a clean bill of health.`
        : "✅ Still accurate — every catalog fact this runbook depends on checks out."
      : report.severity === "warning"
        ? `⚠️ ${report.findings.length} thing${report.findings.length === 1 ? "" : "s"} to know before following this runbook.`
        : `🛑 This runbook is out of date — ${report.findings.filter((f) => f.severity === "broken").length} step${
            report.findings.filter((f) => f.severity === "broken").length === 1 ? "" : "s"
          } would fail if followed as written.`;

  const lines = [
    `# Runbook validation: ${handoff.title}`,
    "",
    headline,
    "",
    // "against the catalog", not "against live DataHub": the same renderer is
    // driven by the interactive demo's fixture, and a note that names a source
    // it did not read is the one kind of dishonesty this project cannot afford.
    `Checked ${report.checkedAt.slice(0, 10)} against the catalog — ${report.stepsChecked} step${
      report.stepsChecked === 1 ? "" : "s"
    } across ${report.entitiesChecked} entit${report.entitiesChecked === 1 ? "y" : "ies"}.`,
    `Runbook recorded ${handoff.createdAt.slice(0, 10)} by ${handoff.author}.`,
    "",
  ];

  if (report.verdict) lines.push(`**Verdict: ${report.verdict}.**`, "");

  // Coverage before findings, deliberately. A reader who stops after the first
  // section should leave knowing how much of this was actually looked at.
  const coverage = report.coverage;
  if (coverage && coverage.stepsTotal > 0) {
    lines.push("## Coverage", "", coverage.summary + ".", "");
    if (coverage.claimsUnvalidatable > 0) {
      lines.push(
        `${coverage.claimsUnvalidatable} of ${coverage.claimsTotal} claims could not be checked either way. ` +
          "Each one is a gap in the catalog, not in the runbook:",
        ""
      );
      for (const step of coverage.steps.filter((s) => s.gaps.length > 0)) {
        lines.push(`- Step ${step.stepIndex + 1} (${step.stepTitle}) — ${step.detail}`);
      }
      lines.push("");
    }
  }

  if (report.findings.length === 0) {
    lines.push("No drift detected among the claims that could be checked.", "");
  } else {
    for (const f of report.findings) {
      const icon = f.severity === "broken" ? "🛑" : "⚠️";
      lines.push(`## ${icon} Step ${f.stepIndex + 1}: ${f.stepTitle}`, "");
      lines.push(`**${f.kind}** — ${f.detail}`, "");
      if (f.remedy) lines.push(f.remedy, "");
      const claim = claimById(report, f.claimId);
      const pinned = claim?.validatedAgainst;
      if (pinned) {
        const now = report.versions?.[f.urn]?.aspects[pinned.aspect];
        lines.push(
          `<sub>Provenance: this step's claim that ${claim.statement.replace(/\.$/, "")} was validated on ` +
            `${pinned.at.slice(0, 10)} against \`${pinned.aspect}@${pinned.aspectVersion}\`; that aspect now reads ` +
            `\`${pinned.aspect}@${now ?? "unreadable"}\`. Claim id \`${claim.id}\`.</sub>`,
          ""
        );
      }
    }
  }

  // The claims that still hold matter as much as the ones that broke: they are
  // the part of the runbook the successor can follow without re-checking.
  const verdicts = report.verdicts ?? [];
  if (verdicts.length) {
    const holds = verdicts.filter((v) => v.status === "holds").length;
    const cannotTell = verdicts.filter((v) => v.status === "unvalidatable").length;
    const unchanged = verdicts.filter((v) => v.aspectUnchanged).length;
    lines.push(
      "## Provenance",
      "",
      `${verdicts.length} catalog claim${verdicts.length === 1 ? "" : "s"} in this runbook, each pinned to the ` +
        `version of the catalog aspect it was validated against. ${holds} still hold${holds === 1 ? "s" : ""}; ` +
        `${unchanged} sit on aspects that have not changed at all since the runbook was recorded` +
        `${cannotTell ? `; ${cannotTell} could not be checked (marked \`~\`)` : ""}.`,
      "",
      "```",
      ...(report.claims ?? []).map((c) => {
        const v = verdicts.find((x) => x.claimId === c.id);
        return v ? chainLine(c, v) : `? step ${c.stepIndex + 1} · ${c.statement} — not re-checked`;
      }),
      "```",
      ""
    );
  }

  lines.push("---", "_Validated automatically by instaboard against the DataHub catalog._");
  return lines.join("\n");
}
