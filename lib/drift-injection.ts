/**
 * Planting known drift in a catalog, so detection can be scored rather than
 * demonstrated.
 *
 * `npm run prove` breaks three things and checks all three are caught. That is a
 * demonstration, and N=1 per kind. It says nothing about how often the engine
 * fires when it shouldn't, which is the number that decides whether anyone can
 * live with it: a detector that catches everything and also cries wolf twice a
 * week gets muted in a fortnight.
 *
 * So this plants many drifts of each kind across many datasets, mixed with
 * **decoys** — real catalog changes that no runbook depends on, which the engine
 * must ignore. Precision comes from the decoys; recall comes from the plants.
 * Without the decoys, precision is free and the number means nothing.
 *
 * Ground truth for column drift is derived by parsing the step's SQL for
 * identifiers and intersecting with the dataset's real columns — deliberately a
 * *different* method from the engine's own reference detection, so recall is not
 * scored against the same heuristic that produces it.
 *
 * Everything is reversible. Each planted drift carries what it needs to undo
 * itself, and the benchmark restores in reverse order.
 */

import { datahubGraphQL } from "./datahub-graphql";
import { readAspect, writeAspect } from "./gms-aspects";
import { callDataHubTool } from "./mcp";
import type { DecayKind, EntitySnapshot, Handoff } from "./types";

export type DriftKind = "column-dropped" | "column-renamed" | "deprecated" | "owner-removed";

export interface PlannedDrift {
  id: string;
  kind: DriftKind;
  urn: string;
  /** Column name or owner URN, depending on the kind. */
  subject: string;
  /**
   * The finding the engine should produce, or `null` for a decoy — a real
   * catalog change that no runbook leans on, which must produce nothing.
   */
  expect: DecayKind | null;
  decoy: boolean;
  /** Which runbook is supposed to notice, when it isn't a decoy. */
  runbookId?: string;
  /** Everything needed to put the catalog back. */
  undo: Record<string, unknown>;
  detail: string;
}

/* ── Ground truth ─────────────────────────────────────────────────────── */

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "group", "order", "by", "as", "and", "or", "not", "null", "join", "left", "right",
  "inner", "outer", "on", "limit", "desc", "asc", "sum", "count", "avg", "min", "max", "case", "when", "then",
  "else", "end", "distinct", "having", "with", "union", "all", "over", "partition", "date", "current_date",
  "interval", "cast", "coalesce", "round", "between", "in", "is", "like",
]);

/**
 * Identifiers a step's SQL actually mentions.
 *
 * Independent of the decay engine's own word-boundary matcher: this tokenises
 * SQL and drops keywords, so a column it returns is one a reader would agree the
 * query selects. Using the engine's matcher here would make recall a measurement
 * of the harness agreeing with itself.
 */
export function columnsReferencedInSql(sql: string): string[] {
  const identifiers = sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  return [...new Set(identifiers.filter((id) => !SQL_KEYWORDS.has(id) && id.length > 2))];
}

/** Columns a runbook step genuinely reads, per its SQL and the live schema. */
export function groundTruthColumns(step: { sql?: string }, snapshot: EntitySnapshot): string[] {
  if (!step.sql) return [];
  const referenced = new Set(columnsReferencedInSql(step.sql));
  return snapshot.fields.filter((f) => referenced.has(f.toLowerCase()));
}

/* ── Planning ─────────────────────────────────────────────────────────── */

export interface PlanOptions {
  /** Cap plants per kind, so one big runbook cannot dominate the score. */
  maxPerKind?: number;
  /** How many decoys to plant. Precision is only meaningful if this is > 0. */
  decoys?: number;
  /**
   * Of those, how many to plant on datasets a runbook actually reads. These are
   * the decoys that test something: the engine has a snapshot of the entity and
   * must still stay quiet about a column no step mentions.
   */
  sharpDecoys?: number;
}

/**
 * Choose what to break.
 *
 * Plants only where the ground truth is unambiguous: a column the step's SQL
 * selects, a dataset a step points at, an owner a step names. Decoys are the
 * mirror image — columns no runbook's SQL mentions, on datasets no runbook
 * touches.
 */
export function planDrifts(
  runbooks: Handoff[],
  live: Record<string, EntitySnapshot>,
  decoyCandidates: EntitySnapshot[],
  options: PlanOptions = {}
): PlannedDrift[] {
  const { maxPerKind = 6, decoys = 6, sharpDecoys = 2 } = options;
  const plans: PlannedDrift[] = [];
  const counts: Record<DriftKind, number> = {
    "column-dropped": 0,
    "column-renamed": 0,
    deprecated: 0,
    "owner-removed": 0,
  };
  // One change per dataset: two drifts on one entity make attribution ambiguous.
  const claimed = new Set<string>();

  const usedUrns = new Set(runbooks.flatMap((r) => r.steps.map((s) => s.urn).filter(Boolean) as string[]));

  /** Columns any step of any runbook mentions, in SQL or in prose. */
  const referencedOn = (urn: string) =>
    new Set(
      runbooks
        .flatMap((r) => r.steps)
        .filter((s) => s.urn === urn)
        .flatMap((s) =>
          columnsReferencedInSql(s.sql ?? "").concat(
            `${s.instruction} ${s.why} ${s.tips ?? ""}`.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []
          )
        )
    );

  /*
   * Reserve a couple of runbook-used datasets for decoys *before* planting any
   * drift on them. This is the decoy that actually tests something: the engine
   * holds a snapshot of the entity, sees a column disappear from it, and must
   * still stay quiet because no step reads that column. Decoys on datasets no
   * runbook touches are nearly free to pass.
   */
  let sharp = 0;
  for (const snapshot of Object.values(live)) {
    if (sharp >= sharpDecoys) break;
    if (!snapshot.exists || snapshot.fields.length < 3) continue;
    const referenced = referencedOn(snapshot.urn);
    const unreferenced = snapshot.fields.find((f) => !referenced.has(f.toLowerCase()));
    if (!unreferenced) continue;

    claimed.add(snapshot.urn);
    sharp++;
    plans.push({
      id: `decoy:${snapshot.urn}:${unreferenced}`,
      kind: "column-dropped",
      urn: snapshot.urn,
      subject: unreferenced,
      expect: null,
      decoy: true,
      undo: { aspect: "schemaMetadata" },
      detail:
        `Drop \`${unreferenced}\` from ${snapshot.name ?? snapshot.urn} — a dataset a runbook DOES read, but no ` +
        `step references this column. Must produce nothing.`,
    });
  }

  /*
   * Rotate through the kinds rather than always planting the first applicable
   * one. Preferring drops meant renames and owner drift almost never got
   * planted, so the benchmark reported perfect scores for two kinds and said
   * nothing at all about the other two.
   */
  const ROTATION: DriftKind[] = ["column-dropped", "column-renamed", "deprecated", "owner-removed"];
  let rotation = 0;

  /** Everything that could be broken on this step, by kind. */
  function applicable(step: Handoff["steps"][number], snapshot: EntitySnapshot): Partial<Record<DriftKind, string>> {
    const columns = groundTruthColumns(step, snapshot);
    const named = (snapshot.ownerUrns ?? []).find((ownerUrn) => {
      const username = ownerUrn.split(":").pop() ?? "";
      const haystack = `${step.instruction} ${step.why} ${step.tips ?? ""}`.toLowerCase();
      const parts = username.split(/[._@]/).filter((p) => p.length > 2);
      return parts.length > 0 && parts.every((p) => haystack.includes(p));
    });
    return {
      ...(columns.length ? { "column-dropped": columns[0] } : {}),
      ...(columns.length ? { "column-renamed": columns[columns.length - 1] } : {}),
      ...(snapshot.deprecated ? {} : { deprecated: snapshot.urn }),
      ...(named ? { "owner-removed": named } : {}),
    };
  }

  const EXPECTED: Record<DriftKind, DecayKind> = {
    "column-dropped": "column-missing",
    "column-renamed": "column-missing",
    deprecated: "newly-deprecated",
    "owner-removed": "owner-changed",
  };

  for (const runbook of runbooks) {
    runbook.steps.forEach((step, stepIndex) => {
      if (!step.urn || claimed.has(step.urn)) return;
      const snapshot = live[step.urn];
      if (!snapshot?.exists) return;

      const options_ = applicable(step, snapshot);
      // Start at whichever kind is next in the rotation and take the first one
      // this dataset can actually support.
      let chosen: DriftKind | null = null;
      for (let i = 0; i < ROTATION.length; i++) {
        const kind = ROTATION[(rotation + i) % ROTATION.length];
        if (options_[kind] !== undefined && counts[kind] < maxPerKind) {
          chosen = kind;
          break;
        }
      }
      if (!chosen) return;

      rotation++;
      claimed.add(step.urn);
      counts[chosen]++;
      const subject = options_[chosen]!;
      plans.push({
        id: `${chosen}:${step.urn}:${subject}`,
        kind: chosen,
        urn: step.urn,
        subject,
        expect: EXPECTED[chosen],
        decoy: false,
        runbookId: runbook.id,
        undo:
          chosen === "owner-removed"
            ? { mcp: "add_owners", ownershipType: "__system__technical_owner" }
            : chosen === "deprecated"
              ? { mutation: "updateDeprecation" }
              : { aspect: "schemaMetadata" },
        detail:
          chosen === "deprecated"
            ? `Deprecate ${snapshot.name ?? step.urn}, which step ${stepIndex + 1} of "${runbook.title}" points at.`
            : chosen === "owner-removed"
              ? `Remove ${subject} from ${snapshot.name ?? step.urn}, whom step ${stepIndex + 1} of "${runbook.title}" names.`
              : `${chosen === "column-renamed" ? "Rename" : "Drop"} \`${subject}\` on ${snapshot.name ?? step.urn}, which step ${stepIndex + 1} of "${runbook.title}" selects.`,
      });
    });
  }

  /*
   * Decoys: real changes to datasets no runbook touches, plus a dropped column
   * on a dataset a runbook *does* touch but whose SQL never mentions it. The
   * second kind is the sharper test — the engine has a snapshot of that entity
   * and must still stay quiet.
   */
  let planted = sharp;
  for (const snapshot of decoyCandidates) {
    if (planted >= decoys) break;
    if (claimed.has(snapshot.urn) || !snapshot.exists || snapshot.fields.length < 2) continue;

    const referenced = referencedOn(snapshot.urn);
    const unreferenced = snapshot.fields.find((f) => !referenced.has(f.toLowerCase()));
    if (!unreferenced) continue;

    claimed.add(snapshot.urn);
    planted++;
    plans.push({
      id: `decoy:${snapshot.urn}:${unreferenced}`,
      kind: "column-dropped",
      urn: snapshot.urn,
      subject: unreferenced,
      expect: null,
      decoy: true,
      undo: { aspect: "schemaMetadata" },
      detail:
        `Drop \`${unreferenced}\` from ${snapshot.name ?? snapshot.urn} — no runbook step references it` +
        `${usedUrns.has(snapshot.urn) ? ", though a runbook does use this dataset" : ""}. Must produce nothing.`,
    });
  }

  return plans;
}

/* ── Injecting and reverting ──────────────────────────────────────────── */

const UPDATE_DEPRECATION = `
  mutation updateDeprecation($input: UpdateDeprecationInput!) { updateDeprecation(input: $input) }
`;

interface SchemaField {
  fieldPath: string;
  [key: string]: unknown;
}

const RENAMED_SUFFIX = "_v2";

export async function injectDrift(drift: PlannedDrift): Promise<boolean> {
  switch (drift.kind) {
    case "column-dropped": {
      const schema = await readAspect(drift.urn, "schemaMetadata");
      if (!schema) return false;
      const fields = (schema.fields ?? []) as SchemaField[];
      const removed = fields.find((f) => f.fieldPath === drift.subject);
      if (!removed) return false;
      drift.undo.field = removed;
      await writeAspect(drift.urn, "schemaMetadata", {
        ...schema,
        fields: fields.filter((f) => f.fieldPath !== drift.subject),
      });
      return true;
    }

    case "column-renamed": {
      const schema = await readAspect(drift.urn, "schemaMetadata");
      if (!schema) return false;
      const fields = (schema.fields ?? []) as SchemaField[];
      if (!fields.some((f) => f.fieldPath === drift.subject)) return false;
      await writeAspect(drift.urn, "schemaMetadata", {
        ...schema,
        fields: fields.map((f) =>
          f.fieldPath === drift.subject ? { ...f, fieldPath: `${drift.subject}${RENAMED_SUFFIX}` } : f
        ),
      });
      return true;
    }

    case "deprecated": {
      const result = await datahubGraphQL(UPDATE_DEPRECATION, {
        input: {
          urn: drift.urn,
          deprecated: true,
          note: "Deprecated by instaboard's drift benchmark. Use the replacement named by the team.",
        },
      });
      return !result.errors?.length;
    }

    case "owner-removed": {
      const result = await callDataHubTool("remove_owners", {
        owner_urns: [drift.subject],
        entity_urns: [drift.urn],
      });
      return !result.isError;
    }
  }
}

export async function revertDrift(drift: PlannedDrift): Promise<boolean> {
  switch (drift.kind) {
    case "column-dropped": {
      const field = drift.undo.field as SchemaField | undefined;
      if (!field) return false;
      const schema = await readAspect(drift.urn, "schemaMetadata");
      if (!schema) return false;
      const fields = (schema.fields ?? []) as SchemaField[];
      if (fields.some((f) => f.fieldPath === field.fieldPath)) return true;
      await writeAspect(drift.urn, "schemaMetadata", { ...schema, fields: [...fields, field] });
      return true;
    }

    case "column-renamed": {
      const schema = await readAspect(drift.urn, "schemaMetadata");
      if (!schema) return false;
      const fields = (schema.fields ?? []) as SchemaField[];
      const renamed = `${drift.subject}${RENAMED_SUFFIX}`;
      if (!fields.some((f) => f.fieldPath === renamed)) return true;
      await writeAspect(drift.urn, "schemaMetadata", {
        ...schema,
        fields: fields.map((f) => (f.fieldPath === renamed ? { ...f, fieldPath: drift.subject } : f)),
      });
      return true;
    }

    case "deprecated": {
      const result = await datahubGraphQL(UPDATE_DEPRECATION, {
        input: { urn: drift.urn, deprecated: false, note: "" },
      });
      return !result.errors?.length;
    }

    case "owner-removed": {
      const result = await callDataHubTool("add_owners", {
        owner_urns: [drift.subject],
        entity_urns: [drift.urn],
        ownership_type: drift.undo.ownershipType ?? "__system__technical_owner",
      });
      return !result.isError;
    }
  }
}
