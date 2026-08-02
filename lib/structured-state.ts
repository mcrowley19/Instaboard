/**
 * Writing runbook staleness into DataHub as structured state, not just prose.
 *
 * A drift note is a document. A person has to open it, read it, and decide it
 * applies to them. Everything in this file is the opposite of that: values you
 * can filter search on, aggregate, alert on, and read back mechanically six
 * months later to answer "when did this stop being true, and what broke it?"
 *
 * Three surfaces, all native:
 *
 *   • a **custom assertion** per (runbook, dataset), reported FAILING while the
 *     runbook is stale and PASSING once it validates clean again. It lands in the
 *     dataset's health badge and its assertion history, so staleness gets the same
 *     timeline treatment as a freshness check;
 *   • **assertion result properties**, a string map carrying the specific catalog
 *     change that broke it and the provenance chain that proves it — claim id,
 *     the aspect version it was validated against, the aspect version now;
 *   • **structured properties** on the dataset, holding the current status, the
 *     drift detail, and the validated-against pin, one entry per runbook.
 *
 * Everything is keyed by runbook id, so several runbooks can touch the same
 * dataset without overwriting each other's state, and re-running the sweep
 * updates in place rather than piling up duplicates.
 */

import { createHash } from "node:crypto";
import { datahubGraphQL, gmsReachable } from "./datahub-graphql";
import { isDemoMode } from "./mcp";
import { chainLine } from "./provenance";
import type { DecayFinding, DecayReport, Handoff, RunbookClaim } from "./types";

/* ── Structured property definitions ──────────────────────────────────── */

/**
 * `showAsAssetBadge` on the status property is the point of the whole exercise:
 * it puts "runbook:stale" on the dataset's header in the DataHub UI, where
 * somebody about to query the table will see it without going looking.
 */
const PROPERTIES = [
  {
    id: "instaboard_runbook_status",
    displayName: "Runbook status",
    description:
      "Per-runbook validation state, formatted '<runbook-id>: stale|validated (checked YYYY-MM-DD)'. " +
      "Written by instaboard's decay sweep from a deterministic diff of the catalog against the state " +
      "captured when the runbook was recorded.",
    settings: { showAsAssetBadge: true, showInSearchFilters: true, showInAssetSummary: true },
  },
  {
    id: "instaboard_runbook_drift",
    displayName: "Runbook drift",
    description:
      "The specific catalog change that invalidated a saved runbook step, formatted " +
      "'<runbook-id> step N <kind>: <detail>'. One value per broken claim.",
    settings: { showInSearchFilters: true, showInAssetSummary: true },
  },
  {
    id: "instaboard_runbook_validated_against",
    displayName: "Runbook validated against",
    description:
      "The provenance pin for each runbook claim on this dataset, formatted " +
      "'<runbook-id> <claim-id> <aspect>@<version-when-recorded> -> <aspect>@<version-now> (<verdict>)'. " +
      "Versions are content fingerprints of the aspect and can be recomputed from the catalog.",
    settings: { showInSearchFilters: false, showInAssetSummary: false },
  },
] as const;

type PropertyId = (typeof PROPERTIES)[number]["id"];

const propertyUrn = (id: PropertyId) => `urn:li:structuredProperty:${id}`;

const CREATE_PROPERTY = `
  mutation createStructuredProperty($input: CreateStructuredPropertyInput!) {
    createStructuredProperty(input: $input) { urn }
  }
`;

const READ_PROPERTIES = `
  query($urn: String!) {
    dataset(urn: $urn) {
      structuredProperties {
        properties {
          structuredProperty { urn }
          values { ... on StringValue { stringValue } }
        }
      }
    }
  }
`;

const UPSERT_PROPERTIES = `
  mutation upsertStructuredProperties($input: UpsertStructuredPropertiesInput!) {
    upsertStructuredProperties(input: $input) {
      properties { structuredProperty { urn } }
    }
  }
`;

/**
 * Define the properties if this DataHub has never seen them. Creation is
 * idempotent in practice because a second create on an existing id errors and we
 * ignore it — cheaper and less racy than reading first.
 */
async function ensureProperties(): Promise<void> {
  await Promise.all(
    PROPERTIES.map((p) =>
      datahubGraphQL(CREATE_PROPERTY, {
        input: {
          id: p.id,
          qualifiedName: p.id,
          displayName: p.displayName,
          description: p.description,
          valueType: "urn:li:dataType:datahub.string",
          cardinality: "MULTIPLE",
          entityTypes: ["urn:li:entityType:datahub.dataset"],
          settings: p.settings,
        },
      })
    )
  );
}

/** Current string values of one property on one dataset. */
async function readValues(datasetUrn: string): Promise<Record<PropertyId, string[]>> {
  const empty = Object.fromEntries(PROPERTIES.map((p) => [p.id, [] as string[]])) as Record<PropertyId, string[]>;
  const res = await datahubGraphQL<{
    dataset: {
      structuredProperties: {
        properties: { structuredProperty: { urn: string }; values: { stringValue?: string }[] }[];
      } | null;
    } | null;
  }>(READ_PROPERTIES, { urn: datasetUrn });

  for (const entry of res.data?.dataset?.structuredProperties?.properties ?? []) {
    const match = PROPERTIES.find((p) => propertyUrn(p.id) === entry.structuredProperty.urn);
    if (!match) continue;
    empty[match.id] = entry.values.map((v) => v.stringValue).filter((v): v is string => Boolean(v));
  }
  return empty;
}

/**
 * Replace this runbook's entries and keep everybody else's.
 *
 * `upsertStructuredProperties` overwrites the whole value list for a property, so
 * a naive write would silently delete the drift another runbook recorded on the
 * same dataset. Each value is prefixed with its runbook id; we drop ours, keep
 * the rest, and write the union back.
 */
function mergeValues(existing: string[], runbookId: string, mine: string[]): string[] {
  const others = existing.filter((v) => !v.startsWith(`${runbookId} `) && !v.startsWith(`${runbookId}:`));
  // DataHub caps property value lists; keep it bounded and deterministic.
  return [...others, ...mine].slice(0, 50);
}

/* ── Custom assertion ─────────────────────────────────────────────────── */

const UPSERT_ASSERTION = `
  mutation upsertCustomAssertion($urn: String, $input: UpsertCustomAssertionInput!) {
    upsertCustomAssertion(urn: $urn, input: $input) { urn }
  }
`;

const REPORT_RESULT = `
  mutation reportAssertionResult($urn: String!, $result: AssertionResultInput!) {
    reportAssertionResult(urn: $urn, result: $result)
  }
`;

/**
 * `upsertCustomAssertion` returns a URN before GMS has finished associating the
 * assertion with its dataset, and reporting a result against an assertion in that
 * window fails with "does not exist or is not associated with any entity". So
 * retry briefly rather than dropping the result — the first attempt usually
 * lands, and when it doesn't the second one does.
 */
async function reportResultWithRetry(
  urn: string,
  result: Record<string, unknown>,
  attempts = 4
): Promise<{ ok: boolean; error?: string }> {
  let last = "no attempt made";
  for (let i = 0; i < attempts; i++) {
    const res = await datahubGraphQL<{ reportAssertionResult: boolean }>(REPORT_RESULT, { urn, result });
    if (res.data?.reportAssertionResult) return { ok: true };
    last = res.errors?.map((e) => e.message).join("; ") || "reportAssertionResult returned false";
    if (!/does not exist|not associated/i.test(last)) break;
    await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
  }
  return { ok: false, error: last };
}

/**
 * One stable assertion per (runbook, dataset). Deriving the URN from a hash of
 * the pair rather than letting DataHub mint one means the nightly sweep reports
 * a new *result* against the same assertion instead of creating a new assertion
 * every night, which is what gives the dataset a staleness timeline.
 */
export function assertionUrnFor(runbookId: string, datasetUrn: string): string {
  return `urn:li:assertion:instaboard-${createHash("sha256").update(`${runbookId}|${datasetUrn}`).digest("hex").slice(0, 20)}`;
}

/** The string map that rides along with an assertion result — the audit record. */
function resultProperties(
  handoff: Handoff,
  report: DecayReport,
  datasetUrn: string,
  findings: DecayFinding[]
): { key: string; value: string }[] {
  const claimFor = (id?: string) => report.claims?.find((c) => c.id === id);
  const props: { key: string; value: string }[] = [
    { key: "runbook.id", value: handoff.id },
    { key: "runbook.title", value: handoff.title },
    { key: "runbook.author", value: handoff.author },
    { key: "runbook.recordedAt", value: handoff.createdAt },
    { key: "validation.checkedAt", value: report.checkedAt },
    { key: "validation.severity", value: report.severity },
    { key: "validation.method", value: "deterministic catalog diff (no LLM)" },
    { key: "validation.brokenClaims", value: String(findings.length) },
  ];

  const version = report.versions?.[datasetUrn];
  if (version) {
    props.push({ key: "entity.version", value: version.entity });
    for (const [aspect, v] of Object.entries(version.aspects)) {
      props.push({ key: `entity.version.${aspect}`, value: v });
    }
  }

  findings.forEach((f, i) => {
    const claim = claimFor(f.claimId);
    const pinned = claim?.validatedAgainst;
    props.push({ key: `drift.${i}.kind`, value: f.kind });
    props.push({ key: `drift.${i}.step`, value: `${f.stepIndex + 1}. ${f.stepTitle}` });
    props.push({ key: `drift.${i}.detail`, value: f.detail });
    if (f.remedy) props.push({ key: `drift.${i}.remedy`, value: f.remedy });
    if (claim) props.push({ key: `drift.${i}.claim`, value: claim.id });
    if (pinned) {
      props.push({
        key: `drift.${i}.validatedAgainst`,
        value: `${pinned.aspect}@${pinned.aspectVersion} on ${pinned.at.slice(0, 10)}`,
      });
      const now = version?.aspects[pinned.aspect];
      if (now) props.push({ key: `drift.${i}.nowReads`, value: `${pinned.aspect}@${now}` });
    }
  });

  return props;
}

/* ── Public API ───────────────────────────────────────────────────────── */

export interface StructuredStateReceipt {
  /** False when GMS never answered (demo mode) — nothing was attempted. */
  attempted: boolean;
  /** Assertions upserted this run: one per (runbook, dataset). */
  assertions: { urn: string; datasetUrn: string; result: "FAILURE" | "SUCCESS" }[];
  /** Datasets whose structured properties now carry this runbook's state. */
  properties: { datasetUrn: string; status: string; driftValues: number; pins: number }[];
  errors: string[];
  at: string;
}

/**
 * Write the validation result as structured state on every dataset the runbook
 * touches — including the clean ones, because "this runbook was re-validated
 * against this dataset today and still holds" is the fact that makes the state
 * trustworthy. A dataset that only ever gets written to when something breaks
 * can't distinguish "fine" from "nobody checked".
 */
export async function writeStructuredState(handoff: Handoff, report: DecayReport): Promise<StructuredStateReceipt> {
  const receipt: StructuredStateReceipt = {
    attempted: false,
    assertions: [],
    properties: [],
    errors: [],
    at: new Date().toISOString(),
  };

  const urns = [...new Set(handoff.steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];
  if (urns.length === 0) return receipt;

  // Demo mode answers reads from a fixture. If a real GMS happens to be running
  // on this machine, writing fixture-derived state into it would put claims about
  // a catalog we never read onto datasets somebody else owns. Skip, always.
  if (isDemoMode()) return receipt;
  if (!(await gmsReachable())) return receipt;
  receipt.attempted = true;

  await ensureProperties();

  const findingsByUrn = new Map<string, DecayFinding[]>();
  for (const f of report.findings) findingsByUrn.set(f.urn, [...(findingsByUrn.get(f.urn) ?? []), f]);

  const claimsByUrn = new Map<string, RunbookClaim[]>();
  for (const c of report.claims ?? []) claimsByUrn.set(c.urn, [...(claimsByUrn.get(c.urn) ?? []), c]);

  for (const datasetUrn of urns) {
    const findings = findingsByUrn.get(datasetUrn) ?? [];
    const stale = findings.some((f) => f.severity === "broken");
    const day = report.checkedAt.slice(0, 10);

    /* 1. The assertion, and its result. */
    try {
      const assertionUrn = assertionUrnFor(handoff.id, datasetUrn);
      const upserted = await datahubGraphQL<{ upsertCustomAssertion: { urn: string } }>(UPSERT_ASSERTION, {
        urn: assertionUrn,
        input: {
          entityUrn: datasetUrn,
          type: "Runbook validity",
          description:
            `Every catalog claim made by the saved runbook "${handoff.title}" about this dataset still holds. ` +
            `Checked by re-reading the catalog and diffing it against the state captured when the runbook was ` +
            `recorded on ${handoff.createdAt.slice(0, 10)}. Deterministic; no LLM judgement.`,
          platform: { name: "instaboard" },
          logic: (claimsByUrn.get(datasetUrn) ?? []).map((c) => `${c.kind}: ${c.statement}`).join("\n") || "no claims",
        },
      });

      if (!upserted.data?.upsertCustomAssertion?.urn) {
        receipt.errors.push(
          `upsertCustomAssertion(${datasetUrn}): ${upserted.errors?.map((e) => e.message).join("; ") || "no urn returned"}`
        );
      } else {
        const type = stale ? "FAILURE" : "SUCCESS";
        const reported = await reportResultWithRetry(upserted.data.upsertCustomAssertion.urn, {
          type,
          timestampMillis: Date.parse(report.checkedAt),
          properties: resultProperties(handoff, report, datasetUrn, findings),
        });
        if (!reported.ok) {
          receipt.errors.push(`reportAssertionResult(${datasetUrn}): ${reported.error}`);
        } else {
          receipt.assertions.push({ urn: upserted.data.upsertCustomAssertion.urn, datasetUrn, result: type });
        }
      }
    } catch (err) {
      receipt.errors.push(`assertion(${datasetUrn}): ${err instanceof Error ? err.message : String(err)}`);
    }

    /* 2. Structured properties: status, the drift itself, and the pins. */
    try {
      const status = `${handoff.id}: ${stale ? "stale" : "validated"} (checked ${day})`;
      const drift = findings.map((f) => `${handoff.id} step ${f.stepIndex + 1} ${f.kind}: ${f.detail}`);
      const pins = (claimsByUrn.get(datasetUrn) ?? []).map((c) => {
        const verdict = report.verdicts?.find((v) => v.claimId === c.id);
        const from = c.validatedAgainst;
        const to = verdict?.checkedAgainst;
        return (
          `${handoff.id} ${c.id} ` +
          `${from ? `${from.aspect}@${from.aspectVersion}` : "unpinned"} -> ` +
          `${to ? `${to.aspect}@${to.aspectVersion}` : "unreadable"} (${verdict?.status ?? "unverified"})`
        );
      });

      const current = await readValues(datasetUrn);
      const written = await datahubGraphQL(UPSERT_PROPERTIES, {
        input: {
          assetUrn: datasetUrn,
          structuredPropertyInputParams: [
            {
              structuredPropertyUrn: propertyUrn("instaboard_runbook_status"),
              values: mergeValues(current.instaboard_runbook_status, handoff.id, [status]).map((stringValue) => ({
                stringValue,
              })),
            },
            {
              structuredPropertyUrn: propertyUrn("instaboard_runbook_drift"),
              values: mergeValues(current.instaboard_runbook_drift, handoff.id, drift).map((stringValue) => ({
                stringValue,
              })),
            },
            {
              structuredPropertyUrn: propertyUrn("instaboard_runbook_validated_against"),
              values: mergeValues(current.instaboard_runbook_validated_against, handoff.id, pins).map((stringValue) => ({
                stringValue,
              })),
            },
          ],
        },
      });

      if (written.errors?.length) {
        receipt.errors.push(`upsertStructuredProperties(${datasetUrn}): ${written.errors.map((e) => e.message).join("; ")}`);
      } else {
        receipt.properties.push({ datasetUrn, status, driftValues: drift.length, pins: pins.length });
      }
    } catch (err) {
      receipt.errors.push(`properties(${datasetUrn}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return receipt;
}

/** Human-readable provenance block for an incident body or a PR description. */
export function provenanceBlock(report: DecayReport, datasetUrn?: string): string {
  const claims = (report.claims ?? []).filter((c) => !datasetUrn || c.urn === datasetUrn);
  if (!claims.length) return "";
  return claims
    .map((c) => {
      const verdict = report.verdicts?.find((v) => v.claimId === c.id);
      return verdict ? chainLine(c, verdict) : `? step ${c.stepIndex + 1} · ${c.statement} — not re-checked`;
    })
    .join("\n");
}
