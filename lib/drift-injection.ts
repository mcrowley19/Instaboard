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

/**
 * Changes that are real, land on datasets runbooks actually read, and leave every
 * runbook still correct. A column appears, a description is rewritten, a second
 * owner joins — the catalog moves, the fingerprint moves with it, and a detector
 * that treats "the aspect changed" as "the runbook broke" fires on all three.
 *
 * Decoys test that the engine ignores changes to things nobody reads. Controls
 * test the harder thing: that it ignores changes to things people *do* read, when
 * those changes take nothing away.
 *
 * One kind is deliberately absent. "An assertion was added and passes" belongs on
 * this list, and planting it would leave permanent residue: `deleteAssertion`
 * refuses the custom assertions `upsertCustomAssertion` creates
 * (datahub#18817), so the benchmark could not put the catalog back. Everything
 * here is reversible, and that constraint is worth more than the extra control.
 */
export type ControlKind = "column-added" | "description-edited" | "owner-added";

export type PlantKind = DriftKind | ControlKind;

export interface PlannedDrift {
  id: string;
  kind: PlantKind;
  urn: string;
  /** Column name or owner URN, depending on the kind. */
  subject: string;
  /**
   * The finding the engine should produce, or `null` for a decoy or a control —
   * a real catalog change no runbook is invalidated by, which must produce nothing.
   */
  expect: DecayKind | null;
  decoy: boolean;
  /** An *additive* change on a dataset a runbook reads. See `ControlKind`. */
  control?: boolean;
  /** Which runbook is supposed to notice, when it isn't a decoy. */
  runbookId?: string;
  /** For renames: the exact new name, so a proposed correction can be scored. */
  renameTo?: string;
  /**
   * Why this plant is expected to be hard, where it is. Recorded when the plant
   * is made rather than when it fails, so a miss comes with a structural reason
   * instead of one written after the fact to fit the result.
   */
  hardCase?: string;
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
  /**
   * How many renames should go to a name that shares nothing with the original.
   * The rename detector scores string similarity, so `net_amount_usd` →
   * `net_revenue_usd` is easy and `net_amount_usd` → `settled_value` is the case
   * it cannot solve. Planting at least one means the benchmark reports a real
   * limit rather than a score assembled from cases the rule was built for.
   */
  hardRenames?: number;
}

/** Names sharing no tokens with anything in this catalog — a rename nobody can infer. */
const UNRELATED_NAMES = ["settled_value", "reported_figure", "ledger_quantity", "txn_metric"];

function renameTarget(subject: string, hard: boolean, index: number, taken: string[]): string {
  if (!hard) return `${subject}${RENAMED_SUFFIX}`;
  const candidates = UNRELATED_NAMES.filter((n) => !taken.includes(n));
  return candidates[index % Math.max(1, candidates.length)] ?? `${subject}${RENAMED_SUFFIX}`;
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
  const { maxPerKind = 6, decoys = 6, sharpDecoys = 2, hardRenames = 1 } = options;
  let hardRenamesLeft = hardRenames;
  const renameTargets: string[] = [];
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

      // Renames alternate between a name a reader could infer and one nobody
      // could. Both are real renames; only one is solvable by string similarity.
      let renameTo: string | undefined;
      let hardCase: string | undefined;
      if (chosen === "column-renamed") {
        const hard = hardRenamesLeft > 0;
        renameTo = renameTarget(subject, hard, renameTargets.length, renameTargets);
        renameTargets.push(renameTo);
        if (hard) {
          hardRenamesLeft--;
          hardCase =
            `\`${subject}\` → \`${renameTo}\` shares no tokens with the original, so the name carries no signal ` +
            `at all: token overlap and edit distance both score it near zero, and any matcher that connected the ` +
            `two on their names would be matching noise. It is solvable only structurally — one column left, one ` +
            `arrived, in the same slot — which is a strictly weaker kind of evidence and is proposed at lower ` +
            `confidence. Detection should catch the column as missing either way.`;
        }
      }

      plans.push({
        id: `${chosen}:${step.urn}:${subject}`,
        kind: chosen,
        urn: step.urn,
        subject,
        expect: EXPECTED[chosen],
        decoy: false,
        runbookId: runbook.id,
        ...(renameTo ? { renameTo } : {}),
        ...(hardCase ? { hardCase } : {}),
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
              : chosen === "column-renamed"
              ? `Rename \`${subject}\` → \`${renameTo}\` on ${snapshot.name ?? step.urn}, which step ${stepIndex + 1} of "${runbook.title}" selects.`
              : `Drop \`${subject}\` on ${snapshot.name ?? step.urn}, which step ${stepIndex + 1} of "${runbook.title}" selects.`,
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

/* ── Controls ─────────────────────────────────────────────────────────── */

/** The column a `column-added` control introduces. Named so it can't collide. */
export const CONTROL_COLUMN = "instaboard_control_added_col";

/**
 * Plant additive changes on datasets runbooks read.
 *
 * Deliberately *not* subject to the one-change-per-dataset rule the drifts obey.
 * A control and a drift can share a table without ambiguity because a control is
 * scored on its own subject: the question is whether any new finding names the
 * column that appeared, the owner that joined, or the description that changed.
 * Reserving separate datasets for controls would instead starve the drift plan on
 * a small catalog, and shrink the thing being measured to buy a tidier rule.
 */
export function planControls(
  runbooks: Handoff[],
  live: Record<string, EntitySnapshot>,
  count = 3
): PlannedDrift[] {
  const plans: PlannedDrift[] = [];
  const usable = Object.values(live).filter((s) => s.exists && s.fields.length > 1);
  if (!usable.length) return plans;

  const readBySomeStep = (urn: string) => runbooks.some((r) => r.steps.some((s) => s.urn === urn));
  const candidates = usable.filter((s) => readBySomeStep(s.urn));
  const pool = candidates.length ? candidates : usable;

  /* 1. A column appears. The schema fingerprint moves; nothing was taken away. */
  const forColumn = pool[0];
  plans.push({
    id: `control:column-added:${forColumn.urn}`,
    kind: "column-added",
    urn: forColumn.urn,
    subject: CONTROL_COLUMN,
    expect: null,
    decoy: true,
    control: true,
    undo: { aspect: "schemaMetadata" },
    detail:
      `Add a column \`${CONTROL_COLUMN}\` to ${forColumn.name ?? forColumn.urn}, a dataset a runbook reads. ` +
      `The schema aspect changes and every existing claim stays true. Must produce nothing.`,
  });

  /* 2. The description is rewritten. Documentation churn is constant in a real
        catalog, and a detector that reports it is one nobody keeps switched on. */
  const forDescription = pool[1 % pool.length];
  plans.push({
    id: `control:description-edited:${forDescription.urn}`,
    kind: "description-edited",
    urn: forDescription.urn,
    subject: "description",
    expect: null,
    decoy: true,
    control: true,
    undo: { aspect: "editableDatasetProperties" },
    detail:
      `Rewrite the description of ${forDescription.name ?? forDescription.urn}, a dataset a runbook reads. ` +
      `Must produce nothing.`,
  });

  /* 3. A second owner joins. The ownership aspect moves, and the person the
        runbook names is still there — so the owner claim must still hold. This is
        the sharpest of the three: it is one field away from real owner drift. */
  const owners = [...new Set(Object.values(live).flatMap((s) => s.ownerUrns ?? []))].filter((u) =>
    u.startsWith("urn:li:corpuser:")
  );
  const forOwner = pool.find((s) => owners.some((o) => !(s.ownerUrns ?? []).includes(o)));
  const newOwner = forOwner && owners.find((o) => !(forOwner.ownerUrns ?? []).includes(o));
  if (forOwner && newOwner) {
    plans.push({
      id: `control:owner-added:${forOwner.urn}`,
      kind: "owner-added",
      urn: forOwner.urn,
      subject: newOwner,
      expect: null,
      decoy: true,
      control: true,
      undo: { mcp: "remove_owners" },
      detail:
        `Add ${newOwner} as a second owner of ${forOwner.name ?? forOwner.urn}, without removing the owner a ` +
        `runbook step names. The ownership aspect changes; the person to contact has not. Must produce nothing.`,
    });
  }

  return plans.slice(0, count);
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
      const to = drift.renameTo ?? `${drift.subject}${RENAMED_SUFFIX}`;
      await writeAspect(drift.urn, "schemaMetadata", {
        ...schema,
        fields: fields.map((f) => (f.fieldPath === drift.subject ? { ...f, fieldPath: to } : f)),
      });
      return true;
    }

    /* ── Controls: real changes that must produce nothing ─────────────── */

    case "column-added": {
      const schema = await readAspect(drift.urn, "schemaMetadata");
      if (!schema) return false;
      const fields = (schema.fields ?? []) as SchemaField[];
      if (!fields.length || fields.some((f) => f.fieldPath === drift.subject)) return false;
      // Clone an existing field so the added column is structurally valid rather
      // than a hand-built object GMS might reject for an unrelated reason.
      await writeAspect(drift.urn, "schemaMetadata", {
        ...schema,
        fields: [...fields, { ...fields[0], fieldPath: drift.subject, description: "Added by the drift benchmark." }],
      });
      return true;
    }

    case "description-edited": {
      const props = (await readAspect(drift.urn, "editableDatasetProperties")) ?? {};
      drift.undo.previous = props.description ?? null;
      await writeAspect(drift.urn, "editableDatasetProperties", {
        ...props,
        description:
          `${props.description ? `${props.description}\n\n` : ""}Edited by instaboard's drift benchmark as a ` +
          `control: documentation changed, nothing a runbook depends on did.`,
      });
      return true;
    }

    case "owner-added": {
      const result = await callDataHubTool("add_owners", {
        owner_urns: [drift.subject],
        entity_urns: [drift.urn],
        ownership_type: "__system__technical_owner",
      });
      return !result.isError;
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
      const renamed = drift.renameTo ?? `${drift.subject}${RENAMED_SUFFIX}`;
      if (!fields.some((f) => f.fieldPath === renamed)) return true;
      await writeAspect(drift.urn, "schemaMetadata", {
        ...schema,
        fields: fields.map((f) => (f.fieldPath === renamed ? { ...f, fieldPath: drift.subject } : f)),
      });
      return true;
    }

    case "column-added": {
      const schema = await readAspect(drift.urn, "schemaMetadata");
      if (!schema) return false;
      const fields = (schema.fields ?? []) as SchemaField[];
      if (!fields.some((f) => f.fieldPath === drift.subject)) return true;
      await writeAspect(drift.urn, "schemaMetadata", {
        ...schema,
        fields: fields.filter((f) => f.fieldPath !== drift.subject),
      });
      return true;
    }

    case "description-edited": {
      const props = (await readAspect(drift.urn, "editableDatasetProperties")) ?? {};
      const previous = drift.undo.previous;
      await writeAspect(drift.urn, "editableDatasetProperties", {
        ...props,
        description: typeof previous === "string" ? previous : "",
      });
      return true;
    }

    case "owner-added": {
      const result = await callDataHubTool("remove_owners", {
        owner_urns: [drift.subject],
        entity_urns: [drift.urn],
      });
      return !result.isError;
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
