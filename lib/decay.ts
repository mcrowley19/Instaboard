import { callDataHubTool } from "./mcp";
import { datahubGraphQL } from "./datahub-graphql";
import type { EntitySnapshot, DecayFinding, DecayReport, Handoff } from "./types";

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
function ownerIdentities(parsed: unknown): string[] {
  const out: string[] = [];

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
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const owner = ((entry as Record<string, unknown>).owner ?? entry) as Record<string, unknown>;
      if (typeof owner === "string") {
        out.push(owner);
        continue;
      }
      const props = (owner.properties ?? owner.info ?? {}) as Record<string, unknown>;
      for (const candidate of [props.displayName, owner.username, owner.name, props.email, owner.urn]) {
        if (typeof candidate === "string" && candidate) out.push(candidate);
      }
    }
  }
  return [...new Set(out)];
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
    const urnCauses = causes.filter((c) => c.startsWith("urn:li:"));
    const fromMessage = Number(String(e.message ?? "").match(/(\d+)/)?.[1] ?? 0);
    const count = urnCauses.length || fromMessage || 1;
    const type = String(e.type ?? "").toUpperCase();
    if (type === "ASSERTIONS") snapshot.failingAssertions = Math.max(snapshot.failingAssertions, count);
    if (type === "INCIDENTS") snapshot.openIncidents = Math.max(snapshot.openIncidents, count);
  }
}

/**
 * Don't let the tool's own write-back read back as new drift.
 *
 * When a sweep finds a broken runbook it raises an Incident on the dataset. The
 * next sweep then sees an open incident that wasn't there at record time and
 * reports it as fresh drift. instaboard flagging instaboard, every night, for
 * ever. So discount the incidents this tool raised. They are titled
 * "Stale runbook: <runbook>".
 *
 * This has to go over GraphQL. The entity's inlined health summary reports
 * `causes: ["ACTIVE_INCIDENTS"]` rather than the incident URNs, and reading an
 * incident by URN through `get_entities` returns "exists but no data could be
 * retrieved", because incidents are not readable over MCP today. Demo mode has no
 * GMS behind the fixture, so the call fails fast and the count is left alone.
 */
async function discountSelfRaisedIncidents(snapshot: EntitySnapshot): Promise<void> {
  if (snapshot.openIncidents === 0) return;

  const res = await datahubGraphQL<{
    dataset: { incidents: { incidents: { title: string }[] } } | null;
  }>(
    `query($urn: String!) {
       dataset(urn: $urn) { incidents(state: ACTIVE, start: 0, count: 50) { incidents { title } } }
     }`,
    { urn: snapshot.urn }
  );

  const open = res.data?.dataset?.incidents?.incidents;
  if (!open) return;
  const ours = open.filter((i) => /^stale runbook:/i.test(i.title ?? "")).length;
  if (ours > 0) snapshot.openIncidents = Math.max(0, snapshot.openIncidents - ours);
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
  const snapshot: EntitySnapshot = {
    ...base,
    exists: true,
    name: names[0],
    fields: [...new Set(flatStrings(collect(parsed, "fieldPath")))],
    owners,
    deprecated: collect(parsed, "deprecated").some((d) => d === true || (d && typeof d === "object")),
    openIncidents: countByStatus(parsed, "incidents", "open") + countByStatus(parsed, "openIncidents", "open"),
    failingAssertions: countByStatus(parsed, "assertions", "fail"),
  };
  applyHealthSummary(parsed, snapshot);
  await discountSelfRaisedIncidents(snapshot);

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
    }
  }

  return snapshot;
}

/** Snapshot every distinct entity a runbook's steps touch. */
export async function snapshotHandoff(steps: { urn?: string }[]): Promise<Record<string, EntitySnapshot>> {
  const urns = [...new Set(steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];
  const snapshots = await Promise.all(urns.map(snapshotEntity));
  return Object.fromEntries(snapshots.map((s) => [s.urn, s]));
}

/* ── Decay detection ──────────────────────────────────────────────────── */

/** Does this step's prose or SQL actually depend on the given identifier? */
function stepReferences(step: { instruction: string; why: string; sql?: string; tips?: string }, token: string): boolean {
  const haystack = [step.instruction, step.why, step.sql ?? "", step.tips ?? ""].join(" ");
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(haystack);
}

/** Owner display names the step tells the successor to contact. */
function ownersNamedIn(step: { why: string; tips?: string; instruction: string }, knownOwners: string[]): string[] {
  const haystack = [step.instruction, step.why, step.tips ?? ""].join(" ");
  return knownOwners.filter((owner) => {
    // Owner strings look like "Priya Patel (Payments Data Lead, urn:li:corpuser:priya.patel)".
    const display = owner.split("(")[0].trim();
    return display.length > 2 && haystack.includes(display);
  });
}

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
  const findings: DecayFinding[] = [];
  const live = await snapshotHandoff(handoff.steps);
  const recorded = handoff.snapshots ?? {};

  handoff.steps.forEach((step, i) => {
    if (!step.urn) return;
    const now = live[step.urn];
    const then = recorded[step.urn];
    const where = { stepIndex: i, stepTitle: step.title, urn: step.urn };

    if (!now || !now.exists) {
      findings.push({
        ...where,
        severity: "broken",
        kind: "entity-missing",
        detail: `\`${step.urn}\` is no longer in the catalog.`,
        remedy: "The entity was removed or renamed. Find its replacement and rewrite this step.",
      });
      return;
    }

    // Columns the step depends on that have disappeared since it was written.
    if (then?.exists && then.fields.length) {
      const removed = then.fields.filter((f) => !now.fields.includes(f));
      for (const field of removed) {
        if (!stepReferences(step, field)) continue;
        findings.push({
          ...where,
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
        severity: "broken",
        kind: "newly-deprecated",
        detail: `${now.name ?? step.urn} has been deprecated since this runbook was written.`,
        remedy: "Point this step at the replacement dataset named in DataHub.",
      });
    } else if (now.deprecated) {
      findings.push({
        ...where,
        severity: "warning",
        kind: "deprecated",
        detail: `${now.name ?? step.urn} is deprecated.`,
        remedy: "Point this step at the replacement dataset named in DataHub.",
      });
    }

    if (now.openIncidents > (then?.openIncidents ?? 0)) {
      findings.push({
        ...where,
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
      const display = owner.split("(")[0].trim();
      // Live DataHub renders owners as usernames ("mike.rodriguez"), snapshots
      // may hold display names ("Mike Rodriguez") — compare normalized.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const stillOwns = now.owners.some((o) => norm(o).includes(norm(display)));
      if (!stillOwns) {
        findings.push({
          ...where,
          severity: "warning",
          kind: "owner-changed",
          detail: `This step says to contact ${display}, who no longer owns ${now.name ?? step.urn}.`,
          remedy: `Current owner${now.owners.length === 1 ? "" : "s"}: ${
            now.owners.map((o) => o.split("(")[0].trim()).join(", ") || "none listed"
          }.`,
        });
      }
    }
  });

  const severity = findings.reduce<DecayFinding["severity"]>(
    (worst, f) => (RANK[f.severity] > RANK[worst] ? f.severity : worst),
    "ok"
  );

  return {
    handoffId: handoff.id,
    checkedAt: new Date().toISOString(),
    severity,
    stepsChecked: handoff.steps.filter((s) => s.urn).length,
    entitiesChecked: Object.keys(live).length,
    hadSnapshot: Object.keys(recorded).length > 0,
    findings,
  };
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
      ? "✅ Still accurate — every catalog fact this runbook depends on checks out."
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
    `Checked ${report.checkedAt.slice(0, 10)} against live DataHub — ${report.stepsChecked} step${
      report.stepsChecked === 1 ? "" : "s"
    } across ${report.entitiesChecked} entit${report.entitiesChecked === 1 ? "y" : "ies"}.`,
    `Runbook recorded ${handoff.createdAt.slice(0, 10)} by ${handoff.author}.`,
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("No drift detected.", "");
  } else {
    for (const f of report.findings) {
      const icon = f.severity === "broken" ? "🛑" : "⚠️";
      lines.push(`## ${icon} Step ${f.stepIndex + 1}: ${f.stepTitle}`, "");
      lines.push(`**${f.kind}** — ${f.detail}`, "");
      if (f.remedy) lines.push(f.remedy, "");
    }
  }

  lines.push("---", "_Validated automatically by instaboard against the DataHub catalog._");
  return lines.join("\n");
}
