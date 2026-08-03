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

import { callDataHubTool, isDemoMode } from "./mcp";
import { datahubGraphQL, gmsReachable } from "./datahub-graphql";
import { otherRunbooksStaleOn, provenanceBlock } from "./structured-state";
import type { DecayFinding, DecayReport, EntitySnapshot, Handoff } from "./types";

/** Tag ids become the URN suffix, so keep it URN-safe; the display name carries the spaces. */
export const STALE_RUNBOOK_TAG_ID = "StaleRunbook";
export const STALE_RUNBOOK_TAG_URN = `urn:li:tag:${STALE_RUNBOOK_TAG_ID}`;

/**
 * A second tag, for the case the first one cannot express: the runbook did not
 * drift, but this dataset could not answer the questions it asks. Kept separate
 * on purpose — merging it into `Stale Runbook` would tell whoever finds it to go
 * and fix the runbook, when the thing to fix is the catalog entry.
 */
export const UNVALIDATED_TAG_ID = "UnvalidatedRunbookStep";
export const UNVALIDATED_TAG_URN = `urn:li:tag:${UNVALIDATED_TAG_ID}`;

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

/*
 * Removal goes over GraphQL even though the MCP server exposes `remove_tags`,
 * because both retraction paths need per-dataset outcomes: which tags actually
 * came off, and which were kept because another runbook is still stale. The batch
 * tool returns one result for the whole call, so a partial failure would be
 * indistinguishable from a clean sweep in the receipt. Application still uses
 * `add_tags` — there, one result for the batch is the honest shape.
 */
const REMOVE_TAG = `
  mutation removeTag($input: TagAssociationInput!) { removeTag(input: $input) }
`;

const TAG_DEFINITIONS = {
  [STALE_RUNBOOK_TAG_URN]: {
    id: STALE_RUNBOOK_TAG_ID,
    name: "Stale Runbook",
    description:
      "A saved runbook or onboarding document that references this dataset no longer matches the catalog. " +
      "Check the linked validation note before following it.",
  },
  [UNVALIDATED_TAG_URN]: {
    id: UNVALIDATED_TAG_ID,
    name: "Unvalidated Runbook Step",
    description:
      "A saved runbook has a step pointing at this dataset, and the catalog holds too little about it for that " +
      "step to be checked — no schema, no owners, or no assertions. The runbook has not been shown to be wrong; " +
      "it has not been shown to be right either. Adding the missing metadata makes it checkable.",
  },
} as const;

const TAG_READY_TIMEOUT_MS = 30_000;

/**
 * Whether the tag is really there, which is not the same as whether the URN
 * resolves. A tag that has been deleted still comes back from `tag(urn:)` with
 * its URN and `properties: null`, and applying that one fails validation exactly
 * as a tag that never existed does — so the name is what gets asked for.
 */
async function tagExists(tagUrn: string): Promise<boolean> {
  const existing = await datahubGraphQL<{ tag: { urn: string; properties: { name: string } | null } | null }>(
    `query($urn: String!) { tag(urn: $urn) { urn properties { name } } }`,
    { urn: tagUrn }
  );
  return Boolean(existing.data?.tag?.properties?.name);
}

/**
 * Ensure a tag exists before applying it. DataHub will happily attach a tag URN
 * that has no tag entity behind it, which renders in the UI as a bare URN with no
 * description, which is no use to whoever finds it.
 *
 * Creating it is not the same as being able to use it. `createTag` returns as
 * soon as the write is accepted, but the validator behind `add_tags` rejects a
 * label whose entity it cannot see yet — "Failed to validate label with urn
 * urn:li:tag:StaleRunbook. Urn does not exist." — so on a catalog that has never
 * carried this tag, creating it and immediately applying it loses the race and
 * every tag in the run silently fails to land.
 *
 * That is invisible on a catalog anyone has run this against before, because
 * there the tag already exists and the query above short-circuits. It shows up
 * on the first run against a fresh DataHub and nowhere else, which is where CI
 * found it. So: read it back, as everything else here does, rather than trusting
 * the write.
 */
async function ensureTag(tagUrn: keyof typeof TAG_DEFINITIONS): Promise<void> {
  if (await tagExists(tagUrn)) return;

  await datahubGraphQL(CREATE_TAG, { input: TAG_DEFINITIONS[tagUrn] });

  const deadline = Date.now() + TAG_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await tagExists(tagUrn)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  // Fall through rather than throw: the caller's write will fail on its own and
  // be reported as a failed check, which is more useful than an exception that
  // takes the rest of the sweep down with it.
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

const UPDATE_INCIDENT = `
  mutation updateIncident($urn: String!, $input: UpdateIncidentInput!) { updateIncident(urn: $urn, input: $input) }
`;

const RESOLVE_INCIDENT = `
  mutation updateIncidentStatus($urn: String!, $input: IncidentStatusInput!) {
    updateIncidentStatus(urn: $urn, input: $input)
  }
`;

/**
 * Close the loop the other way.
 *
 * A detector that only ever opens incidents is a detector nobody trusts for
 * long: after a month the dataset carries a wall of stale-runbook incidents,
 * most of which were fixed weeks ago, and the signal is worthless. So when a
 * runbook validates clean, the incidents this tool raised for it get resolved,
 * with a message saying what changed.
 *
 * Only ours, matched on the title convention, and only for this runbook.
 */
export async function resolveIncidentsFor(
  handoff: Handoff,
  datasetUrns: string[]
): Promise<{ urn: string; datasetUrn: string }[]> {
  const resolved: { urn: string; datasetUrn: string }[] = [];
  const title = incidentTitle(handoff);

  for (const datasetUrn of datasetUrns) {
    const open = await datahubGraphQL<{
      dataset: { incidents: { incidents: { urn: string; title: string }[] } } | null;
    }>(LIST_OPEN_INCIDENTS, { urn: datasetUrn });

    for (const incident of open.data?.dataset?.incidents?.incidents ?? []) {
      if (incident.title !== title) continue;
      const result = await datahubGraphQL(RESOLVE_INCIDENT, {
        urn: incident.urn,
        input: {
          state: "RESOLVED",
          message:
            `Re-validated against the catalog on ${new Date().toISOString().slice(0, 10)}: every claim this ` +
            `runbook makes about this dataset holds again. Resolved automatically by instaboard's decay sweep.`,
        },
      });
      if (!result.errors?.length) resolved.push({ urn: incident.urn, datasetUrn });
    }
  }
  return resolved;
}

/* ── Retraction ───────────────────────────────────────────────────────── */

export interface RetractionReceipt {
  attempted: boolean;
  /** Datasets the `Stale Runbook` tag was taken off this run. */
  untagged: string[];
  /** Datasets that kept the tag because a different runbook is still stale on them. */
  kept: { datasetUrn: string; heldBy: string[] }[];
  errors: string[];
  at: string;
}

/**
 * Take the warning back down when the runbook is repaired.
 *
 * A tool that only ever adds state is a tool whose state stops meaning anything.
 * After a month of nightly sweeps the catalog carries `Stale Runbook` on tables
 * whose runbooks were fixed in week one, and the tag becomes decoration. So a
 * clean validation removes what the stale one applied, and the removal is a
 * receipt in its own right.
 *
 * Guarded, because the tag is shared. Two runbooks can reference the same table,
 * and clearing the tag when one is repaired would silently retract a warning the
 * other one is still raising. The guard reads the catalog's own status property
 * rather than local storage, so it holds across machines.
 */
export async function retractStaleTags(handoff: Handoff, datasetUrns: string[]): Promise<RetractionReceipt> {
  const receipt: RetractionReceipt = {
    attempted: false,
    untagged: [],
    kept: [],
    errors: [],
    at: new Date().toISOString(),
  };

  if (isDemoMode()) return receipt;
  if (!(await gmsReachable())) return receipt;
  receipt.attempted = true;

  for (const datasetUrn of datasetUrns) {
    try {
      const heldBy = await otherRunbooksStaleOn(datasetUrn, handoff.id);
      if (heldBy.length) {
        receipt.kept.push({ datasetUrn, heldBy });
        continue;
      }
      const removed = await datahubGraphQL<{ removeTag: boolean }>(REMOVE_TAG, {
        input: { tagUrn: STALE_RUNBOOK_TAG_URN, resourceUrn: datasetUrn },
      });
      if (removed.errors?.length) {
        receipt.errors.push(`removeTag(${datasetUrn}): ${removed.errors.map((e) => e.message).join("; ")}`);
      } else {
        receipt.untagged.push(datasetUrn);
      }
    } catch (err) {
      receipt.errors.push(`removeTag(${datasetUrn}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return receipt;
}

/* ── Coverage ─────────────────────────────────────────────────────────── */

export interface CoverageTagReceipt {
  attempted: boolean;
  /** Datasets that gained the `Unvalidated Runbook Step` tag. */
  tagged: string[];
  /** Datasets that lost it, because the missing metadata has since been added. */
  untagged: string[];
  errors: string[];
  at: string;
}

/**
 * Tag the datasets that could not answer, and untag the ones that now can.
 *
 * This runs on every sweep, drift or no drift, because the case it exists for is
 * precisely the clean-looking run: a step pointing at a dataset with no schema,
 * no owners or no monitors produces no findings and no tag, and reads as fine.
 * Applied and retracted symmetrically, so somebody adding an assertion to a table
 * sees the tag disappear on the next sweep — which is the feedback that makes
 * filling the gap worth doing.
 */
export async function writeBackCoverage(handoff: Handoff, report: DecayReport): Promise<CoverageTagReceipt> {
  const receipt: CoverageTagReceipt = {
    attempted: false,
    tagged: [],
    untagged: [],
    errors: [],
    at: new Date().toISOString(),
  };

  const coverage = report.coverage;
  if (!coverage) return receipt;
  if (isDemoMode()) return receipt;
  if (!(await gmsReachable())) return receipt;
  receipt.attempted = true;

  const withGaps = new Set(coverage.gapUrns);
  const covered = coverage.steps
    .filter((s) => s.urn && s.gaps.length === 0)
    .map((s) => s.urn as string)
    .filter((urn) => !withGaps.has(urn));

  if (withGaps.size) {
    try {
      await ensureTag(UNVALIDATED_TAG_URN);
      const result = await callDataHubTool("add_tags", {
        tag_urns: [UNVALIDATED_TAG_URN],
        entity_urns: [...withGaps],
      });
      if (result.isError) receipt.errors.push(`add_tags(coverage): ${result.content.slice(0, 200)}`);
      else receipt.tagged = [...withGaps];
    } catch (err) {
      receipt.errors.push(`add_tags(coverage): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const datasetUrn of covered) {
    const removed = await datahubGraphQL<{ removeTag: boolean }>(REMOVE_TAG, {
      input: { tagUrn: UNVALIDATED_TAG_URN, resourceUrn: datasetUrn },
    });
    // A dataset that never carried the tag is the common case; DataHub returns
    // success for that, and an error here is worth surfacing rather than hiding.
    if (removed.errors?.length) {
      receipt.errors.push(`removeTag(coverage, ${datasetUrn}): ${removed.errors.map((e) => e.message).join("; ")}`);
    } else {
      receipt.untagged.push(datasetUrn);
    }
  }

  return receipt;
}

/**
 * Who the incident goes to.
 *
 * The whole failure mode this tool exists for is a runbook naming somebody who
 * has moved on. So the incident is assigned to whoever owns the dataset *today*,
 * read from the catalog at validation time — which, in the owner-drift case,
 * is precisely the person the runbook doesn't know about yet. DataHub's own
 * subscription and notification machinery takes it from there.
 */
function assigneesFor(datasetUrn: string, live: Record<string, EntitySnapshot>): string[] {
  return (live[datasetUrn]?.ownerUrns ?? []).filter((u) => u.startsWith("urn:li:corpuser:")).slice(0, 10);
}

function incidentTitle(handoff: Handoff): string {
  return `Stale runbook: ${handoff.title}`;
}

function incidentBody(
  handoff: Handoff,
  report: DecayReport,
  findings: DecayFinding[],
  datasetUrn: string,
  documentUrn?: string,
  proposal?: ProposalLink
): string {
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

  // The provenance chain: which claim, validated against which version, reading
  // what now. This is the part that makes the incident checkable rather than
  // something to take on faith.
  const chain = provenanceBlock(report, datasetUrn);
  if (chain) lines.push("", "Provenance — every claim this runbook makes about this dataset:", chain);

  lines.push("");
  if (proposal?.summary) lines.push(`Proposed correction: ${proposal.summary}`);
  if (proposal?.url) lines.push(`Review it here: ${proposal.url}`);
  if (documentUrn) lines.push(`Full validation note: ${documentUrn}`);
  lines.push("Raised automatically by instaboard's runbook decay sweep. Detection is a deterministic");
  lines.push("schema and health diff against the state captured when the runbook was recorded. No LLM judgement.");
  return lines.join("\n");
}

/** A correction waiting for review, linked from the incident so the fix is one click away. */
export interface ProposalLink {
  summary?: string;
  url?: string;
}

/* ── Public API ───────────────────────────────────────────────────────── */

export interface NativeWriteBackReceipt {
  /** False when GMS never answered (demo mode), so nothing was attempted. */
  attempted: boolean;
  /** Incidents raised this run, plus any already-open ones we reused. */
  incidents: { urn: string; datasetUrn: string; reused: boolean; assignees: string[] }[];
  /** Datasets that carry the Stale Runbook tag after this run. */
  tagged: string[];
  errors: string[];
  at: string;
}

/**
 * Raise a native Incident on every dataset a runbook breaks on, assigned to
 * whoever owns that dataset now. Tag every dataset it drifted on.
 *
 * @param documentUrn the drift note's URN when one was written. The incident body
 *   links to it, so the two artifacts point at each other.
 * @param live the snapshots this validation read, used to find the current owners.
 * @param proposal a correction awaiting review, linked from the incident body.
 */
export async function writeBackNative(
  handoff: Handoff,
  report: DecayReport,
  documentUrn?: string,
  live: Record<string, EntitySnapshot> = {},
  proposal?: ProposalLink
): Promise<NativeWriteBackReceipt> {
  const receipt: NativeWriteBackReceipt = {
    attempted: false,
    incidents: [],
    tagged: [],
    errors: [],
    at: new Date().toISOString(),
  };

  if (report.severity === "ok" || report.findings.length === 0) return receipt;

  // Demo mode answers MCP calls from a fixture. Never write fixture-derived
  // findings into a real catalog, even when one happens to be reachable — and
  // when GMS genuinely isn't there, skip rather than fabricate a receipt for a
  // write that never happened.
  if (isDemoMode()) return receipt;
  if (!(await gmsReachable())) return receipt;
  receipt.attempted = true;

  const driftedUrns = [...new Set(report.findings.map((f) => f.urn))];

  /* Tag every drifted dataset. Tagging is cheap and makes staleness searchable. */
  try {
    await ensureTag(STALE_RUNBOOK_TAG_URN);
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
    const assignees = assigneesFor(datasetUrn, live);
    const description = incidentBody(handoff, report, findings, datasetUrn, documentUrn, proposal);

    // Idempotency: a nightly sweep must not open a new incident every night.
    const open = await datahubGraphQL<{
      dataset: { incidents: { incidents: { urn: string; title: string }[] } } | null;
    }>(LIST_OPEN_INCIDENTS, { urn: datasetUrn });
    const existing = open.data?.dataset?.incidents?.incidents?.find((i) => i.title === title);
    if (existing) {
      // Refresh it rather than leaving a stale body: the drift may have grown
      // since it was opened, and ownership may have moved again.
      const updated = await datahubGraphQL(UPDATE_INCIDENT, {
        urn: existing.urn,
        input: { title, description, ...(assignees.length ? { assigneeUrns: assignees } : {}) },
      });
      if (updated.errors?.length) {
        receipt.errors.push(`updateIncident(${existing.urn}): ${updated.errors.map((e) => e.message).join("; ")}`);
      }
      receipt.incidents.push({ urn: existing.urn, datasetUrn, reused: true, assignees });
      continue;
    }

    const { type, customType } = incidentTypeFor(findings);
    const raised = await datahubGraphQL<{ raiseIncident: string }>(RAISE_INCIDENT, {
      input: {
        type,
        ...(customType ? { customType } : {}),
        title,
        description,
        resourceUrn: datasetUrn,
        // A runbook that would fail if followed is a real, but not paging, problem.
        priority: "MEDIUM",
        // Land it on the person who owns the table today — in the owner-drift
        // case, the one the runbook has never heard of.
        ...(assignees.length ? { assigneeUrns: assignees } : {}),
      },
    });

    if (raised.errors?.length || !raised.data?.raiseIncident) {
      receipt.errors.push(
        `raiseIncident(${datasetUrn}): ${raised.errors?.map((e) => e.message).join("; ") || "no URN returned"}`
      );
      continue;
    }
    receipt.incidents.push({ urn: raised.data.raiseIncident, datasetUrn, reused: false, assignees });
  }

  return receipt;
}
