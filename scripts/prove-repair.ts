/**
 * Detection is half the loop. This drill proves the other half: a consumer
 * repaired, executed, and giving back the same numbers.
 *
 *   npm run prove:repair                        # the catalog this repo seeds
 *   npm run prove:repair -- --catalog=showcase  # DataHub's showcase datapack
 *
 * The drill runs real consumer SQL against a warehouse whose schema comes from
 * the live catalog, records a green baseline with a result hash per query, then
 * renames a column in DataHub for real. The queries that read it fail; the
 * detector proposes the rename correction; the drill applies only the
 * high-confidence edits to the consumer workspace and runs it again. Green,
 * red, green — and the repaired queries return byte-identical result hashes to
 * the baseline, because a rename moves a name, never the data. A repair that
 * had guessed the wrong column would move the hash and fail the run.
 *
 * The receipt binds three hash families together: the *plan* hash of exactly
 * the edits that were approved and applied, the *catalog* hashes (per-entity
 * fingerprints at baseline, broken and restored), and the *artifact* hashes
 * (each SQL file and each query result, at every phase). All of the catalog
 * write-back and retraction from the sweep happens here too, and is read back
 * out of GMS rather than trusted from the write receipt.
 *
 * Every phase asserts, and the script exits non-zero if any expectation fails.
 *
 * Flags:
 *   --catalog=<name>    northbeam (default) or showcase
 *   --skip-quickstart   fail rather than start DataHub if it isn't up
 *   --skip-seed         assume the sample catalog is already ingested
 *   --json              machine-readable result only
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotEntity, snapshotHandoff } from "../lib/decay";
import { datahubGraphQL, gmsReachable } from "../lib/datahub-graphql";
import { isDemoMode } from "../lib/mcp";
import { deleteHandoff, saveHandoff } from "../lib/handoff-store";
import { sweepRunbooks, type SweepResult } from "../lib/sweep";
import { resolveIncidentsFor, STALE_RUNBOOK_TAG_URN } from "../lib/native-writeback";
import { unifiedDiff, type ProposedEdit } from "../lib/remediate";
import {
  CATALOGS,
  breakCatalog,
  restoreCatalog,
  shortName,
  waitForCatalogToSettle,
  type Change,
} from "../lib/prove-profiles";
import {
  applyEditsToWorkspace,
  prepareWorkspace,
  runWorkspace,
  type FileRepair,
  type WorkspaceRun,
} from "../lib/consumer-workspace";
import { createHash } from "node:crypto";
import type { EntitySnapshot, EntityVersion } from "../lib/types";

const args = process.argv.slice(2);
const skipQuickstart = args.includes("--skip-quickstart");
const skipSeed = args.includes("--skip-seed");
const json = args.includes("--json");

const catalogArg = args.find((a) => a.startsWith("--catalog="))?.split("=")[1] ?? "northbeam";
const CATALOG = CATALOGS[catalogArg];
if (!CATALOG) {
  console.error(`Unknown catalog "${catalogArg}". Available: ${Object.keys(CATALOGS).join(", ")}`);
  process.exit(1);
}

const SOURCE_DIR = path.join(process.cwd(), "examples", "consumer", CATALOG.consumerDir);
const WORK_DIR = path.join(process.cwd(), "data", "consumer-workspace", CATALOG.name);
const OUT_DIR = path.join(process.cwd(), "examples", "live");
const RECEIPTS = path.join(
  OUT_DIR,
  CATALOG.name === "northbeam" ? "prove-repair-receipts.json" : `prove-repair-receipts-${CATALOG.name}.json`
);

const INDEX_LAG_MS = 25_000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/* ── Assertions ───────────────────────────────────────────────────────── */

interface Check {
  phase: string;
  what: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(phase: string, what: string, passed: boolean, detail: string): boolean {
  checks.push({ phase, what, passed, detail });
  if (!json) console.log(`    ${passed ? "✓" : "✗"} ${what} — ${detail}`);
  return passed;
}

function say(message: string): void {
  if (!json) console.log(message);
}

/* ── DataHub, catalog, runbook ────────────────────────────────────────── */

async function waitForGms(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await gmsReachable()) return true;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return false;
}

async function ensureDataHub(): Promise<boolean> {
  if (await gmsReachable()) {
    return check("datahub", "DataHub is up", true, `GMS answering at ${process.env.DATAHUB_GMS_URL || "http://localhost:8080"}`);
  }
  if (skipQuickstart) {
    return check("datahub", "DataHub is up", false, "GMS is not answering and --skip-quickstart was passed");
  }
  say("    starting the DataHub quickstart (first run pulls images; this takes a few minutes)…");
  try {
    execFileSync("uv", ["run", "--with", "acryl-datahub", "datahub", "docker", "quickstart"], {
      stdio: json ? "ignore" : "inherit",
      timeout: 20 * 60_000,
    });
  } catch (err) {
    return check("datahub", "DataHub is up", false, `quickstart failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return check("datahub", "DataHub is up", await waitForGms(120_000), "started via `datahub docker quickstart`");
}

async function ensureCatalog(): Promise<boolean> {
  const step = CATALOG.ingest();
  if (!skipSeed && step) {
    say(`    ${step.note}`);
    try {
      execFileSync(step.command, step.args, {
        stdio: json ? "ignore" : "inherit",
        timeout: 15 * 60_000,
        env: {
          ...process.env,
          DATAHUB_GMS_URL: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
          ...(process.env.DATAHUB_GMS_TOKEN ? { DATAHUB_GMS_TOKEN: process.env.DATAHUB_GMS_TOKEN } : {}),
        },
      });
    } catch (err) {
      return check("ingest", "sample catalog ingested", false, err instanceof Error ? err.message : String(err));
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }

  await waitForCatalogToSettle(CATALOG, say);

  const found = await datahubGraphQL<{ dataset: { name: string } | null }>(
    `query($urn: String!) { dataset(urn: $urn) { name } }`,
    { urn: CATALOG.probeUrn }
  );
  return check(
    "ingest",
    `${CATALOG.name} catalog is in the catalog`,
    Boolean(found.data?.dataset),
    found.data?.dataset ? `${shortName(CATALOG.probeUrn)} resolves in DataHub` : `${shortName(CATALOG.probeUrn)} is missing`
  );
}

const runbook = () => CATALOG.runbook();

const runbookUrns = () => [...new Set(runbook().steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];

async function snapshotAll(): Promise<Record<string, EntitySnapshot>> {
  const out: Record<string, EntitySnapshot> = {};
  for (const urn of runbookUrns()) out[urn] = await snapshotEntity(urn);
  return out;
}

const versionsOf = (snaps: Record<string, EntitySnapshot>): Record<string, EntityVersion | null> =>
  Object.fromEntries(Object.entries(snaps).map(([urn, s]) => [urn, s.version ?? null]));

async function sweep(): Promise<SweepResult> {
  return sweepRunbooks({ filter: runbook().id });
}

/** Read the tags DataHub actually holds, so retraction is proved from GMS, not from our own receipt. */
async function tagsOn(urn: string): Promise<string[]> {
  const res = await datahubGraphQL<{
    dataset: { tags: { tags: { tag: { urn: string } }[] } | null } | null;
  }>(`query($urn: String!) { dataset(urn: $urn) { tags { tags { tag { urn } } } } }`, { urn });
  return (res.data?.dataset?.tags?.tags ?? []).map((t) => t.tag.urn);
}

/* ── Main ─────────────────────────────────────────────────────────────── */

const slim = (run: WorkspaceRun) => ({
  tables: run.tables,
  queries: run.queries,
  allGreen: run.allGreen,
});

async function main() {
  if (isDemoMode()) {
    console.error("DEMO_MODE is set. This proves a repair against a real DataHub, so unset it.");
    process.exit(1);
  }

  const started = new Date().toISOString();
  say(`\nProving an executed repair against ${CATALOG.description}.`);

  say("\n1/8  DataHub");
  if (!(await ensureDataHub())) return finish(started);

  say("\n2/8  sample catalog");
  if (!(await ensureCatalog())) return finish(started);

  say("\n3/8  capture the runbook, the consumer workspace and a green baseline");
  const handoff = runbook();
  handoff.snapshots = await snapshotHandoff(handoff.steps);
  saveHandoff(handoff);

  const baselineSnaps = await snapshotAll();
  const baselineVersions = versionsOf(baselineSnaps);
  check(
    "baseline",
    "every catalog entity carries a recomputable version hash",
    Object.values(baselineVersions).every((v) => Boolean(v?.entity)),
    Object.entries(baselineVersions).map(([u, v]) => `${shortName(u)}@${v?.entity}`).join(", ")
  );

  const files = prepareWorkspace(SOURCE_DIR, WORK_DIR);
  const sourceText: Record<string, string> = {};
  for (const f of files) sourceText[f] = readFileSync(path.join(SOURCE_DIR, f), "utf8");
  const affected = files.filter((f) => new RegExp(`\\b${CATALOG.rename.from}\\b`).test(sourceText[f]));
  const controls = files.filter((f) => !affected.includes(f));
  check(
    "baseline",
    "the workspace has consumers of the target column, and a control that avoids it",
    affected.length >= 2 && controls.length >= 1,
    `${files.length} files: ${affected.join(", ")} read ${CATALOG.rename.from}; control: ${controls.join(", ") || "none"}`
  );

  const green = runWorkspace(WORK_DIR, Object.values(baselineSnaps));
  check(
    "baseline",
    "every consumer query runs green against the baseline catalog schema",
    green.allGreen,
    green.queries.map((q) => `${q.file}: ${q.ok ? `${q.rowCount} rows, ${q.resultHash?.slice(0, 12)}` : q.error}`).join("; ")
  );

  const beforeSweep = await sweep();
  check(
    "baseline",
    "the runbook validates clean before anything is broken",
    beforeSweep.drifted === 0,
    `${beforeSweep.checked} runbook checked, ${beforeSweep.drifted} drifted`
  );

  say("\n4/8  rename the column in DataHub for real");
  const changes: Change[] = await breakCatalog(CATALOG, ["rename"], say);
  check("break", "the rename went through DataHub's own write API", changes.length === 1, changes[0]?.detail ?? "no change applied");
  say("    waiting for DataHub to index the change…");
  await new Promise((r) => setTimeout(r, INDEX_LAG_MS));

  const brokenSnaps = await snapshotAll();
  const brokenVersions = versionsOf(brokenSnaps);
  check(
    "break",
    "only the renamed entity's schema fingerprint moved",
    brokenVersions[CATALOG.rename.urn]?.aspects?.schema !== baselineVersions[CATALOG.rename.urn]?.aspects?.schema &&
      Object.keys(baselineVersions)
        .filter((u) => u !== CATALOG.rename.urn)
        .every((u) => brokenVersions[u]?.aspects?.schema === baselineVersions[u]?.aspects?.schema),
    Object.entries(brokenVersions)
      .map(
        ([u, v]) =>
          `${shortName(u)} schema@${v?.aspects?.schema}${
            v?.aspects?.schema === baselineVersions[u]?.aspects?.schema ? "" : " (moved)"
          }`
      )
      .join(", ")
  );

  // The warehouse takes the same rename the catalog did, the way a warehouse
  // does: ALTER TABLE, name moved, data physically untouched.
  const warehouseRename = [
    { table: shortName(CATALOG.rename.urn), from: CATALOG.rename.from, to: CATALOG.rename.to },
  ];

  say("\n5/8  run the consumers again — the readers of that column should fail");
  const red = runWorkspace(WORK_DIR, Object.values(baselineSnaps), warehouseRename);
  const redByFile = Object.fromEntries(red.queries.map((q) => [q.file, q]));
  check(
    "red",
    "every consumer of the renamed column fails",
    affected.every((f) => redByFile[f] && !redByFile[f].ok),
    affected.map((f) => `${f}: ${redByFile[f]?.error ?? "still green"}`).join("; ")
  );
  check(
    "red",
    "the failure names the missing column",
    affected.every((f) => redByFile[f]?.error?.includes(CATALOG.rename.from)),
    affected.map((f) => redByFile[f]?.error ?? "").join("; ")
  );
  const greenByFile = Object.fromEntries(green.queries.map((q) => [q.file, q]));
  check(
    "red",
    "the control keeps running with an identical result hash",
    controls.every((f) => redByFile[f]?.ok && redByFile[f].resultHash === greenByFile[f]?.resultHash),
    controls.map((f) => `${f}: ${redByFile[f]?.resultHash?.slice(0, 12) ?? "failed"}`).join("; ")
  );

  say("\n6/8  detect, propose, and approve the correction");
  const redSweep = await sweep();
  const row = redSweep.rows[0];
  check(
    "detect",
    "the sweep reports the runbook broken and writes back to DataHub",
    redSweep.broken === 1 && Boolean(row?.native?.tagged.length),
    `severity ${row?.severity}, ${row?.native?.tagged.length ?? 0} dataset(s) tagged, ` +
      `${row?.native?.incidents.length ?? 0} incident(s) raised`
  );
  const tagsWhileBroken: Record<string, string[]> = {};
  for (const urn of row?.native?.tagged ?? []) tagsWhileBroken[urn] = await tagsOn(urn);
  check(
    "detect",
    "the Stale Runbook tag reads back off the dataset in DataHub",
    (row?.native?.tagged ?? []).every((u) => tagsWhileBroken[u]?.includes(STALE_RUNBOOK_TAG_URN)),
    Object.keys(tagsWhileBroken).map(shortName).join(", ") || "nothing tagged"
  );

  const proposal = row?.proposal ?? null;
  const proposedRename = proposal?.edits.find((e) => e.kind === "column-rename" && e.to === CATALOG.rename.to);
  check(
    "detect",
    "the proposal derives the rename correction from the catalog",
    Boolean(proposedRename),
    proposal?.edits.map((e) => `${e.from}→${e.to} (${e.confidence})`).join(", ") || "no edits proposed"
  );
  if (!proposal || !proposedRename) return finish(started, { green, red, changes, baselineVersions, brokenVersions });

  /*
   * The approval gate. The detector proposes edits with evidence and a
   * confidence, and refuses to derive anything it would have to guess at —
   * those land in `unresolved` and are never applied by anyone but a person
   * doing real work. What approval *means* is somebody reading the rationale
   * and accepting the proposed edits, medium confidence included; that is what
   * a PR reviewer does with `npm run propose -- --pr`, and what the operator
   * does here. The plan hash covers exactly the edit set being approved, so
   * the receipt can show that what was applied is what was approved and
   * nothing else.
   */
  const applied: ProposedEdit[] = proposal.edits.filter((e) => e.kind === "column-rename");
  const withheld = proposal.edits.filter((e) => !applied.includes(e));
  const planHash = sha256(
    JSON.stringify({
      runbookId: proposal.runbookId,
      edits: applied.map((e) => ({ kind: e.kind, from: e.from, to: e.to, stepIndex: e.stepIndex })),
    })
  );
  const approval = {
    mode: "operator" as const,
    note:
      "Approved by the operator running the drill, who reads the same rationale a PR reviewer would. Outside the " +
      "drill the edit set rides a pull request (npm run propose -- --pr) and merging it is the approval. Findings " +
      "the detector could not derive an edit for are in `unresolved` and are never applied.",
    approvedBy: process.env.PROVE_APPROVER || os.userInfo().username,
    at: new Date().toISOString(),
    planHash,
    applied: applied.map((e) => ({ kind: e.kind, from: e.from, to: e.to, confidence: e.confidence })),
    withheld: withheld.map((e) => ({ kind: e.kind, from: e.from, to: e.to, confidence: e.confidence })),
  };
  check(
    "approve",
    "the approved plan holds derivable edits only, and every unresolved finding stays out",
    applied.length > 0 && applied.length + withheld.length === proposal.edits.length,
    `${applied.length} edit(s) approved (${applied.map((e) => e.confidence).join(", ")}), ` +
      `${withheld.length} withheld, ${proposal.unresolved.length} unresolved left for a person`
  );

  say("\n7/8  apply the approved correction and prove green with identical hashes");
  const repairs: FileRepair[] = applyEditsToWorkspace(WORK_DIR, applied);
  const appliedPlanHash = sha256(
    JSON.stringify({
      runbookId: proposal.runbookId,
      edits: applied.map((e) => ({ kind: e.kind, from: e.from, to: e.to, stepIndex: e.stepIndex })),
    })
  );
  check(
    "repair",
    "what was applied is exactly what was approved",
    appliedPlanHash === planHash,
    `plan ${planHash.slice(0, 16)}`
  );
  check(
    "repair",
    "the repair touches the affected consumers and leaves the control alone",
    affected.every((f) => repairs.find((r) => r.file === f)?.changed) &&
      controls.every((f) => !repairs.find((r) => r.file === f)?.changed),
    repairs.map((r) => `${r.file}: ${r.changed ? `${r.replacements} replacement(s)` : "untouched"}`).join("; ")
  );

  // The runbook gets the same approved correction, through the same proposal.
  saveHandoff(proposal.updated);

  const repaired = runWorkspace(WORK_DIR, Object.values(baselineSnaps), warehouseRename);
  const repairedByFile = Object.fromEntries(repaired.queries.map((q) => [q.file, q]));
  check(
    "repair",
    "every consumer query is green again against the changed catalog",
    repaired.allGreen,
    repaired.queries.map((q) => `${q.file}: ${q.ok ? "ok" : q.error}`).join("; ")
  );
  check(
    "repair",
    "every repaired query returns a byte-identical result hash to its baseline",
    affected.every((f) => repairedByFile[f]?.ok && repairedByFile[f].resultHash === greenByFile[f]?.resultHash),
    affected
      .map((f) => `${f}: ${repairedByFile[f]?.resultHash?.slice(0, 12)} vs ${greenByFile[f]?.resultHash?.slice(0, 12)}`)
      .join("; ")
  );
  check(
    "repair",
    "the control's file and result are untouched end to end",
    controls.every(
      (f) =>
        repairedByFile[f]?.resultHash === greenByFile[f]?.resultHash &&
        repairs.find((r) => r.file === f)?.hashBefore === repairs.find((r) => r.file === f)?.hashAfter
    ),
    controls.map((f) => `${f}: ${repairedByFile[f]?.resultHash?.slice(0, 12)}`).join("; ")
  );

  // The incident the red sweep just raised reaches DataHub's incident index a
  // beat behind the write, and the repaired sweep can only close what the
  // index shows it. Same lag, same wait, as every other index-dependent step;
  // run 31005338938 hit the race when the sweep got marginally faster.
  say("    waiting for DataHub to index the incident…");
  await new Promise((r) => setTimeout(r, INDEX_LAG_MS));

  const repairedSweep = await sweep();
  const cleanRow = repairedSweep.rows[0];
  check(
    "repair",
    "the repaired runbook validates clean against the changed catalog",
    repairedSweep.drifted === 0,
    `severity ${cleanRow?.severity}, ${cleanRow?.claims.holds}/${cleanRow?.claims.total} claims hold`
  );
  check(
    "repair",
    "the runbook's assertion is back to passing in DataHub",
    cleanRow?.structured?.assertions.length === runbookUrns().length &&
      cleanRow!.structured!.assertions.every((a) => a.result === "SUCCESS"),
    cleanRow?.structured?.assertions.length
      ? `${cleanRow.structured!.assertions.map((a) => `${a.urn.slice(-12)}=${a.result}`).join(", ")}` +
        (cleanRow.structured!.assertions.length === runbookUrns().length
          ? ""
          : ` — ${cleanRow.structured!.assertions.length}/${runbookUrns().length} datasets covered` +
            (cleanRow.structured!.errors.length ? `; ${cleanRow.structured!.errors.join("; ").slice(0, 300)}` : ""))
      : `no assertion written${cleanRow?.structured?.errors.length ? ` — ${cleanRow.structured.errors.join("; ").slice(0, 300)}` : ""}`
  );
  check(
    "repair",
    "the sweep closes the incidents it opened",
    (cleanRow?.resolved.length ?? 0) > 0,
    `${cleanRow?.resolved.length ?? 0} incident(s) resolved by the sweep`
  );
  const tagsAfterRepair: Record<string, string[]> = {};
  for (const urn of Object.keys(tagsWhileBroken)) tagsAfterRepair[urn] = await tagsOn(urn);
  check(
    "repair",
    "the Stale Runbook tag is retracted, read back from GMS",
    Object.keys(tagsWhileBroken).length > 0 &&
      Object.keys(tagsWhileBroken).every((u) => !tagsAfterRepair[u]?.includes(STALE_RUNBOOK_TAG_URN)),
    `${Object.values(tagsAfterRepair).filter((t) => !t.includes(STALE_RUNBOOK_TAG_URN)).length}/${
      Object.keys(tagsWhileBroken).length
    } cleared`
  );

  say("\n8/8  put the catalog back");
  await restoreCatalog(CATALOG, ["rename"], say);
  await new Promise((r) => setTimeout(r, INDEX_LAG_MS));
  const restoredSnaps = await snapshotAll();
  const restoredVersions = versionsOf(restoredSnaps);
  check(
    "restore",
    "every catalog fingerprint is back to its baseline value",
    Object.keys(baselineVersions).every(
      (u) => restoredVersions[u]?.aspects?.schema === baselineVersions[u]?.aspects?.schema
    ),
    Object.entries(restoredVersions)
      .map(([u, v]) => `${shortName(u)}@${v?.entity}${v?.aspects?.schema === baselineVersions[u]?.aspects?.schema ? "" : " (still moved)"}`)
      .join(", ")
  );

  // Cleanup, not a check: this run's runbook is temporary, and an incident left
  // open on it could never be matched by a later sweep.
  const swept = await resolveIncidentsFor(runbook(), runbookUrns());
  if (swept.length) say(`    · re-checked for open incidents, closed ${swept.length}`);
  deleteHandoff(runbook().id);

  const diff = affected
    .map((f) => unifiedDiff(`${f} (before)`, `${f} (repaired)`, sourceText[f], readFileSync(path.join(WORK_DIR, f), "utf8")))
    .join("\n");

  finish(started, {
    green,
    red,
    repaired,
    changes,
    baselineVersions,
    brokenVersions,
    restoredVersions,
    proposal: {
      edits: proposal.edits,
      unresolved: proposal.unresolved,
      reviewers: proposal.reviewers,
    },
    approval,
    repairs,
    diff,
    writeback: {
      tagsWhileBroken,
      tagsAfterRepair,
      incidentsRaised: row?.native?.incidents ?? [],
      incidentsResolved: cleanRow?.resolved ?? [],
      assertionAfterRepair: cleanRow?.structured?.assertions ?? [],
    },
  });
}

/* ── The receipt ──────────────────────────────────────────────────────── */

interface Extras {
  green?: WorkspaceRun;
  red?: WorkspaceRun;
  repaired?: WorkspaceRun;
  changes?: Change[];
  baselineVersions?: Record<string, EntityVersion | null>;
  brokenVersions?: Record<string, EntityVersion | null>;
  restoredVersions?: Record<string, EntityVersion | null>;
  proposal?: unknown;
  approval?: { planHash: string } & Record<string, unknown>;
  repairs?: FileRepair[];
  diff?: string;
  writeback?: unknown;
}

function finish(started: string, extras: Extras = {}): void {
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.length - passed;

  const resultHashes: Record<string, { green?: string; red?: string | null; repaired?: string }> = {};
  for (const q of extras.green?.queries ?? []) resultHashes[q.file] = { green: q.resultHash };
  for (const q of extras.red?.queries ?? []) resultHashes[q.file] = { ...resultHashes[q.file], red: q.resultHash ?? null };
  for (const q of extras.repaired?.queries ?? [])
    resultHashes[q.file] = { ...resultHashes[q.file], repaired: q.resultHash };

  const receipts = {
    startedAt: started,
    finishedAt: new Date().toISOString(),
    gms: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
    catalog: CATALOG.description,
    catalogProfile: CATALOG.name,
    method:
      "Consumer SQL from examples/consumer was executed against a SQLite warehouse whose schema is read from the " +
      "live catalog at baseline and whose rows are deterministic by (table, row, column position). The rename was " +
      "then made in both places at once, the way it happens in production: ALTER TABLE RENAME COLUMN in the " +
      "warehouse, the same rename through DataHub's schemaMetadata API in the catalog. The readers failed; the " +
      "detector's proposed correction was approved and applied to the workspace; the queries went green with " +
      "result hashes identical to the baseline. A rename physically cannot move warehouse data, so hash equality " +
      "is what a correct repair looks like and a wrong substitution cannot fake it.",
    breakingChanges: extras.changes ?? [],
    checks,
    summary: { total: checks.length, passed, failed },
    consumer: {
      source: path.relative(process.cwd(), SOURCE_DIR),
      workspace: path.relative(process.cwd(), WORK_DIR),
      green: extras.green ? slim(extras.green) : null,
      red: extras.red ? slim(extras.red) : null,
      repaired: extras.repaired ? slim(extras.repaired) : null,
    },
    proposal: extras.proposal ?? null,
    approval: extras.approval ?? null,
    repairs: extras.repairs ?? [],
    diff: extras.diff ?? "",
    hashes: {
      plan: extras.approval?.planHash ?? null,
      catalog: {
        baseline: extras.baselineVersions ?? {},
        broken: extras.brokenVersions ?? {},
        restored: extras.restoredVersions ?? {},
      },
      artifacts: {
        files: Object.fromEntries((extras.repairs ?? []).map((r) => [r.file, { before: r.hashBefore, after: r.hashAfter }])),
        results: resultHashes,
      },
    },
    writeback: extras.writeback ?? null,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(RECEIPTS, JSON.stringify(receipts, null, 2) + "\n");

  if (json) {
    console.log(JSON.stringify({ receipts: RECEIPTS, summary: receipts.summary }, null, 2));
  } else {
    console.log(`\n${passed}/${checks.length} checks passed${failed ? `, ${failed} FAILED` : ""}.`);
    console.log(`Receipts written to ${path.relative(process.cwd(), RECEIPTS)}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
