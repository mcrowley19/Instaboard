/**
 * Writing decay findings into DataHub's native operational primitives.
 *
 * A drift note in a Document contributes to the graph and then waits for somebody
 * to read it. The findings that matter most say "following this runbook right now
 * will give you a wrong answer", and those belong where a data team is already
 * looking.
 *
 * A native Incident goes on the affected dataset. It shows on the entity's health
 * badge, filters in search, and fires subscriptions people already set up. Only
 * `broken` findings get one, meaning a runbook that would fail if followed.
 *
 * A `Stale Runbook` tag goes on anything that drifted at all. Tagging is cheap,
 * and it turns "which of our tables have runbooks that have rotted?" into a search
 * query instead of an audit.
 *
 * Both are idempotent. Re-run the sweep and it re-uses the open incident and the
 * tag it already applied.
 */

import { callDataHubTool } from "./mcp";
import { datahubGraphQL, gmsReachable } from "./datahub-graphql";
import type { DecayFinding, DecayReport, Handoff } from "./types";

/** Tag ids become the URN suffix, so keep it URN-safe; the display name carries the spaces. */
export const STALE_RUNBOOK_TAG_ID = "StaleRunbook";
export const STALE_RUNBOOK_TAG_URN = `urn:li:tag:${STALE_RUNBOOK_TAG_ID}`;

/* ── Incident type mapping ────────────────────────────────────────────── */

/**
 * DataHub's incident taxonomy, mapped from what the decay engine found. Using
 * the specific type rather than always CUSTOM means the incident lands in the
 * right bucket in DataHub's own incident filters.
 */
function incidentTypeFor(findings: DecayFinding[]): { type: string; customType?: string } {
  const kinds = new Set(findings.map((f) => f.kind));
  if (kinds.has("column-missing") || kinds.has("entity-missing")) return { type: "DATA_SCHEMA" };
  if (kinds.has("failing-assertion")) return { type: "FRESHNESS" };
  return { type: "CUSTOM", customType: "Stale runbook" };
}

/* ── Tag ──────────────────────────────────────────────────────────────── */

const CREATE_TAG = `
  mutation createTag($input: CreateTagInput!) { createTag(input: $input) }
`;

/**
 * Ensure the `Stale Runbook` tag exists before applying it. DataHub will happily
 * attach a tag URN that has no tag entity behind it, which renders in the UI as
 * a bare URN with no description, which is no use to whoever finds it.
 */
async function ensureStaleRunbookTag(): Promise<void> {
  const existing = await datahubGraphQL<{ tag: { urn: string } | null }>(
    `query($urn: String!) { tag(urn: $urn) { urn } }`,
    { urn: STALE_RUNBOOK_TAG_URN }
  );
  if (existing.data?.tag?.urn) return;

  await datahubGraphQL(CREATE_TAG, {
    input: {
      id: STALE_RUNBOOK_TAG_ID,
      name: "Stale Runbook",
      description:
        "A saved runbook or onboarding document that references this dataset no longer matches the catalog. " +
        "Check the linked validation note before following it.",
    },
  });
}

/* ── Incidents ────────────────────────────────────────────────────────── */

const LIST_OPEN_INCIDENTS = `
  query($urn: String!) {
    dataset(urn: $urn) {
      incidents(state: ACTIVE, start: 0, count: 50) {
        incidents { urn title }
      }
    }
  }
`;

const RAISE_INCIDENT = `
  mutation raiseIncident($input: RaiseIncidentInput!) { raiseIncident(input: $input) }
`;

function incidentTitle(handoff: Handoff): string {
  return `Stale runbook: ${handoff.title}`;
}

function incidentBody(handoff: Handoff, findings: DecayFinding[], documentUrn?: string): string {
  const lines = [
    `The saved runbook "${handoff.title}" (recorded ${handoff.createdAt.slice(0, 10)} by ${handoff.author}) ` +
      `references this dataset, and ${findings.length === 1 ? "one of its steps" : `${findings.length} of its steps`} ` +
      `would not work as written against the catalog as it stands today.`,
    "",
  ];
  for (const f of findings) {
    lines.push(`• Step ${f.stepIndex + 1} (${f.stepTitle}), ${f.kind}: ${f.detail}`);
    if (f.remedy) lines.push(`  ${f.remedy}`);
  }
  lines.push("");
  if (documentUrn) lines.push(`Full validation note: ${documentUrn}`);
  lines.push("Raised automatically by instaboard's runbook decay sweep. Detection is a deterministic");
  lines.push("schema and health diff against the state captured when the runbook was recorded. No LLM judgement.");
  return lines.join("\n");
}

/* ── Public API ───────────────────────────────────────────────────────── */

export interface NativeWriteBackReceipt {
  /** False when GMS never answered (demo mode), so nothing was attempted. */
  attempted: boolean;
  /** Incidents raised this run, plus any already-open ones we reused. */
  incidents: { urn: string; datasetUrn: string; reused: boolean }[];
  /** Datasets that carry the Stale Runbook tag after this run. */
  tagged: string[];
  errors: string[];
  at: string;
}

/**
 * Raise a native Incident on every dataset a runbook breaks on. Tag every dataset
 * it drifted on.
 *
 * @param documentUrn the drift note's URN when one was written. The incident body
 *   links to it, so the two artifacts point at each other.
 */
export async function writeBackNative(
  handoff: Handoff,
  report: DecayReport,
  documentUrn?: string
): Promise<NativeWriteBackReceipt> {
  const receipt: NativeWriteBackReceipt = {
    attempted: false,
    incidents: [],
    tagged: [],
    errors: [],
    at: new Date().toISOString(),
  };

  if (report.severity === "ok" || report.findings.length === 0) return receipt;

  // Demo mode answers MCP calls from a fixture and has no GMS behind it. Skip
  // rather than fabricate a receipt for a write that never happened.
  if (!(await gmsReachable())) return receipt;
  receipt.attempted = true;

  const driftedUrns = [...new Set(report.findings.map((f) => f.urn))];

  /* Tag every drifted dataset. Tagging is cheap and makes staleness searchable. */
  try {
    await ensureStaleRunbookTag();
    const tagResult = await callDataHubTool("add_tags", {
      tag_urns: [STALE_RUNBOOK_TAG_URN],
      entity_urns: driftedUrns,
    });
    if (tagResult.isError) receipt.errors.push(`add_tags: ${tagResult.content.slice(0, 200)}`);
    else receipt.tagged = driftedUrns;
  } catch (err) {
    receipt.errors.push(`add_tags: ${err instanceof Error ? err.message : String(err)}`);
  }

  /* Raise an incident only where a step would actually fail if followed. */
  const brokenByUrn = new Map<string, DecayFinding[]>();
  for (const f of report.findings.filter((f) => f.severity === "broken")) {
    brokenByUrn.set(f.urn, [...(brokenByUrn.get(f.urn) ?? []), f]);
  }

  for (const [datasetUrn, findings] of brokenByUrn) {
    const title = incidentTitle(handoff);

    // Idempotency: a nightly sweep must not open a new incident every night.
    const open = await datahubGraphQL<{
      dataset: { incidents: { incidents: { urn: string; title: string }[] } } | null;
    }>(LIST_OPEN_INCIDENTS, { urn: datasetUrn });
    const existing = open.data?.dataset?.incidents?.incidents?.find((i) => i.title === title);
    if (existing) {
      receipt.incidents.push({ urn: existing.urn, datasetUrn, reused: true });
      continue;
    }

    const { type, customType } = incidentTypeFor(findings);
    const raised = await datahubGraphQL<{ raiseIncident: string }>(RAISE_INCIDENT, {
      input: {
        type,
        ...(customType ? { customType } : {}),
        title,
        description: incidentBody(handoff, findings, documentUrn),
        resourceUrn: datasetUrn,
        // A runbook that would fail if followed is a real, but not paging, problem.
        priority: "MEDIUM",
      },
    });

    if (raised.errors?.length || !raised.data?.raiseIncident) {
      receipt.errors.push(
        `raiseIncident(${datasetUrn}): ${raised.errors?.map((e) => e.message).join("; ") || "no URN returned"}`
      );
      continue;
    }
    receipt.incidents.push({ urn: raised.data.raiseIncident, datasetUrn, reused: false });
  }

  return receipt;
}
