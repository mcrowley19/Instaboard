/**
 * The whole loop, proved end to end, in one command.
 *
 *   npm run prove
 *
 * Starts DataHub if it isn't up, ingests a sample catalog, captures runbooks
 * against it, validates them clean, then makes real breaking changes to that
 * catalog and checks that revalidation catches every one — with the write-back,
 * the provenance chain and the proposed correction all landing in DataHub — then
 * puts the catalog back and checks the runbooks go green again.
 *
 * Every phase asserts. The script exits non-zero if any expectation fails, so
 * "the loop works" is a thing this repo can be *tested* on rather than a thing
 * its README claims. Nothing is stubbed: the catalog is a real DataHub, the
 * breaking changes go through DataHub's own write APIs, and the decay engine is
 * told nothing about them — it re-reads the catalog and works out what happened.
 *
 * Flags:
 *   --skip-quickstart   assume DataHub is already running
 *   --skip-seed         assume the sample catalog is already ingested
 *   --keep-broken       leave the catalog changed so you can look at it in the UI
 *   --json              machine-readable result only
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snapshotHandoff } from "../lib/decay";
import { datahubGraphQL, gmsReachable } from "../lib/datahub-graphql";
import { readAspect, writeAspect } from "../lib/gms-aspects";
import { callDataHubTool, isDemoMode } from "../lib/mcp";
import { deleteHandoff, saveHandoff } from "../lib/handoff-store";
import { sweepRunbooks, type SweepResult } from "../lib/sweep";
import { resolveIncidentsFor } from "../lib/native-writeback";
import { proposalToMarkdown } from "../lib/remediate";
import type { Handoff } from "../lib/types";

const args = process.argv.slice(2);
const skipQuickstart = args.includes("--skip-quickstart");
const skipSeed = args.includes("--skip-seed");
const keepBroken = args.includes("--keep-broken");
const json = args.includes("--json");

const UI = () => process.env.DATAHUB_UI_URL || "http://localhost:9002";
const entityUrl = (urn: string) => `${UI()}/dataset/${encodeURIComponent(urn)}`;

const shortName = (urn: string) => urn.match(/,([^,]+),[^,]*\)$/)?.[1]?.split(".").pop() ?? urn;

const sf = (table: string) =>
  `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.${table},PROD)`;

const FCT_REVENUE = sf("fct_revenue");
const MRR_MONTHLY = sf("mrr_monthly");
const PAYMENT_HEALTH = sf("payment_health_daily");

const MIKE = "urn:li:corpuser:mike.rodriguez";

const OUT_DIR = path.join(process.cwd(), "examples", "live");
const RECEIPTS = path.join(OUT_DIR, "prove-loop-receipts.json");

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

/* ── The runbook under test ───────────────────────────────────────────── */

/**
 * One runbook, three steps, leaning on facts the catalog actually holds: a
 * column its SQL selects, a table it routes you to, and a person it tells you to
 * go and ask. Those are the three things that rot, and phase 5 breaks one of each.
 */
function runbook(): Handoff {
  return {
    id: "prove-monthly-revenue-close",
    title: "Monthly revenue close",
    author: "Priya Patel",
    role: "Payments Data Lead",
    summary:
      "How I close the monthly revenue numbers: check payment health hasn't blown up, pull net revenue off the " +
      "revenue fact, then reconcile against the MRR rollup before finance quotes anything.",
    createdAt: new Date().toISOString(),
    recorded: [],
    steps: [
      {
        title: "Check payment health before trusting anything downstream",
        instruction:
          "Open payment_health_daily and look at success_rate for the last 7 days. Anything under 0.9 on a " +
          "provider means the revenue numbers are understated and the close waits.",
        why: "Failed payments look identical to lost revenue in the fact table. Catching it here saves a restatement.",
        urn: PAYMENT_HEALTH,
        url: entityUrl(PAYMENT_HEALTH),
        sql: "SELECT date, provider, success_rate FROM analytics.marts.payment_health_daily ORDER BY date DESC LIMIT 30;",
      },
      {
        title: "Pull net revenue for the month",
        instruction:
          "Sum net_amount_usd from fct_revenue for the close month. Use net_amount_usd, never gross_amount_usd — " +
          "gross is before refunds and will not tie to the bank.",
        why: "Finance reconciles to settled cash, so refunds have to be out before the number leaves this step.",
        urn: FCT_REVENUE,
        url: entityUrl(FCT_REVENUE),
        sql:
          "SELECT DATE_TRUNC('month', revenue_date) AS month, SUM(net_amount_usd) AS net_revenue\n" +
          "FROM analytics.marts.fct_revenue\nGROUP BY 1 ORDER BY 1 DESC;",
        tips: "If the total looks short, ping Mike Rodriguez — he owns the dbt job that loads this table.",
      },
      {
        title: "Reconcile against the MRR rollup",
        instruction:
          "Compare the recurring slice of the number above against mrr_usd in mrr_monthly for the same month. " +
          "They should agree to within rounding; if they don't, the rollup ran before the fact finished loading.",
        why: "The board deck quotes MRR and finance quotes net revenue. If those two disagree in public it is a bad month.",
        urn: MRR_MONTHLY,
        url: entityUrl(MRR_MONTHLY),
        sql: "SELECT month, SUM(mrr_usd) AS mrr FROM analytics.marts.mrr_monthly GROUP BY 1 ORDER BY 1 DESC LIMIT 12;",
      },
    ],
  };
}

/* ── Phase 1: DataHub ─────────────────────────────────────────────────── */

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

/* ── Phase 2: the sample catalog ──────────────────────────────────────── */

async function ingestCatalog(): Promise<boolean> {
  if (!skipSeed) {
    say("    ingesting the sample catalog (14 datasets, 4 people, glossary, assertions)…");
    try {
      execFileSync("uv", ["run", "--with", "acryl-datahub", "scripts/seed_datahub.py"], {
        stdio: json ? "ignore" : "inherit",
        timeout: 10 * 60_000,
      });
    } catch (err) {
      return check("ingest", "sample catalog ingested", false, err instanceof Error ? err.message : String(err));
    }
    // Search and health are eventually consistent behind GMS.
    await new Promise((r) => setTimeout(r, 15_000));
  }

  const found = await datahubGraphQL<{ dataset: { name: string } | null }>(
    `query($urn: String!) { dataset(urn: $urn) { name } }`,
    { urn: FCT_REVENUE }
  );
  return check(
    "ingest",
    "sample catalog is in the catalog",
    Boolean(found.data?.dataset),
    found.data?.dataset ? `fct_revenue resolves in DataHub` : "fct_revenue is missing"
  );
}

/* ── Phase 3: capture ─────────────────────────────────────────────────── */

async function capture(): Promise<Handoff> {
  const handoff = runbook();
  // The same code path the app runs when somebody stops recording: whatever the
  // live catalog returns right now becomes the decay baseline, fingerprint and all.
  handoff.snapshots = await snapshotHandoff(handoff.steps);
  saveHandoff(handoff);

  const snaps = Object.values(handoff.snapshots);
  check(
    "capture",
    "runbook captured with a catalog baseline",
    snaps.length === 3 && snaps.every((s) => s.exists),
    `${snaps.length} entities snapshotted, ${snaps.filter((s) => s.exists).length} resolved`
  );
  check(
    "capture",
    "every snapshot carries a recomputable version",
    snaps.every((s) => Boolean(s.version?.entity)),
    snaps.map((s) => `${s.name ?? s.urn}@${s.version?.entity}`).join(", ")
  );
  return handoff;
}

/* ── Phase 5: break the catalog ───────────────────────────────────────── */

const UPDATE_DEPRECATION = `
  mutation updateDeprecation($input: UpdateDeprecationInput!) { updateDeprecation(input: $input) }
`;

interface Change {
  kind: string;
  urn: string;
  detail: string;
}

/**
 * Three changes, of the three kinds that actually break runbooks in real life: a
 * column renamed under a query, a table retired mid-workflow, and an owner moved
 * off a dataset a runbook tells you to page them about.
 */
async function breakCatalog(): Promise<Change[]> {
  const changes: Change[] = [];

  /* 1. Rename the column the runbook's SQL selects. */
  const schema = await readAspect(FCT_REVENUE, "schemaMetadata");
  const fields = (schema?.fields ?? []) as Record<string, unknown>[];
  const target = fields.find((f) => f.fieldPath === "net_amount_usd");
  if (schema && target) {
    await writeAspect(FCT_REVENUE, "schemaMetadata", {
      ...schema,
      fields: fields.map((f) => (f.fieldPath === "net_amount_usd" ? { ...f, fieldPath: "net_revenue_usd" } : f)),
    });
    changes.push({
      kind: "column-renamed",
      urn: FCT_REVENUE,
      detail: "Renamed fct_revenue.net_amount_usd to net_revenue_usd — the column step 2's SQL sums.",
    });
    say("    ✓ renamed net_amount_usd → net_revenue_usd on fct_revenue");
  }

  /* 2. Deprecate the table the last step reconciles against. */
  const dep = await datahubGraphQL(UPDATE_DEPRECATION, {
    input: {
      urn: MRR_MONTHLY,
      deprecated: true,
      note: "Rebuilt with plan-level grain at the FY close. Use analytics.marts.mrr_monthly_v2 instead.",
    },
  });
  if (!dep.errors?.length) {
    changes.push({
      kind: "deprecated",
      urn: MRR_MONTHLY,
      detail: "Deprecated mrr_monthly, which step 3 tells you to reconcile against.",
    });
    say("    ✓ deprecated mrr_monthly");
  }

  /* 3. Move the owner the runbook tells you to go and ask. */
  const removed = await callDataHubTool("remove_owners", { owner_urns: [MIKE], entity_urns: [FCT_REVENUE] });
  if (!removed.isError) {
    changes.push({
      kind: "owner-removed",
      urn: FCT_REVENUE,
      detail: "Removed Mike Rodriguez as an owner of fct_revenue, whom step 2 tells you to ping.",
    });
    say("    ✓ removed Mike Rodriguez from fct_revenue");
  }

  return changes;
}

async function restoreCatalog(): Promise<void> {
  // Resolve the incidents this run raised before the runbook is deleted below.
  // An orphaned incident cannot be closed by a later sweep — nothing left in the
  // store matches its title — so it would sit on the dataset forever.
  const resolved = await resolveIncidentsFor(runbook(), [FCT_REVENUE, MRR_MONTHLY, PAYMENT_HEALTH]);
  for (const incident of resolved) say(`    ✓ resolved incident ${incident.urn.slice(-12)} on ${shortName(incident.datasetUrn)}`);

  const schema = await readAspect(FCT_REVENUE, "schemaMetadata");
  const fields = (schema?.fields ?? []) as Record<string, unknown>[];
  if (schema && fields.some((f) => f.fieldPath === "net_revenue_usd")) {
    await writeAspect(FCT_REVENUE, "schemaMetadata", {
      ...schema,
      fields: fields.map((f) => (f.fieldPath === "net_revenue_usd" ? { ...f, fieldPath: "net_amount_usd" } : f)),
    });
    say("    ✓ restored net_amount_usd on fct_revenue");
  }

  await datahubGraphQL(UPDATE_DEPRECATION, { input: { urn: MRR_MONTHLY, deprecated: false, note: "" } });
  say("    ✓ un-deprecated mrr_monthly");

  const added = await callDataHubTool("add_owners", {
    owner_urns: [MIKE],
    entity_urns: [FCT_REVENUE],
    ownership_type: "__system__technical_owner",
  });
  say(
    added.isError
      ? `    • could not restore Mike Rodriguez as an owner: ${added.content.slice(0, 160)}`
      : "    ✓ restored Mike Rodriguez as an owner of fct_revenue"
  );
}

/* ── Phases 4 and 6: validate ─────────────────────────────────────────── */

async function sweep(): Promise<SweepResult> {
  return sweepRunbooks({ filter: "prove-monthly-revenue-close" });
}

function assertClean(result: SweepResult, phase: string): void {
  const row = result.rows[0];
  check(phase, "no drift reported", result.drifted === 0, `${result.checked} runbook checked, ${result.drifted} drifted`);
  check(
    phase,
    "every catalog claim holds",
    Boolean(row) && row.claims.total > 0 && row.claims.broken === 0,
    row ? `${row.claims.holds}/${row.claims.total} claims hold` : "no row"
  );
  check(
    phase,
    "the runbook's assertion is passing in DataHub",
    Boolean(row?.structured?.assertions.length) && row.structured!.assertions.every((a) => a.result === "SUCCESS"),
    row?.structured?.assertions.map((a) => `${a.urn.slice(-12)}=${a.result}`).join(", ") || "no assertion written"
  );
  check(
    phase,
    "validated-against pins are written to the catalog",
    Boolean(row?.structured?.properties.some((p) => p.pins > 0)),
    row?.structured?.properties.map((p) => `${p.pins} pins`).join(", ") || "no properties written"
  );
}

function assertCaught(result: SweepResult): void {
  const row = result.rows[0];
  const kinds = new Set((row?.findings ?? []).map((f) => f.kind));

  check("revalidate", "the runbook is reported broken", result.broken === 1, `${result.broken} broken of ${result.checked}`);
  check(
    "revalidate",
    "the renamed column is caught",
    kinds.has("column-missing"),
    row?.findings.find((f) => f.kind === "column-missing")?.detail ?? "not found"
  );
  check(
    "revalidate",
    "the deprecation is caught",
    kinds.has("newly-deprecated"),
    row?.findings.find((f) => f.kind === "newly-deprecated")?.detail ?? "not found"
  );
  check(
    "revalidate",
    "the owner change is caught",
    kinds.has("owner-changed"),
    row?.findings.find((f) => f.kind === "owner-changed")?.detail ?? "not found"
  );
  check(
    "revalidate",
    "every finding names the claim it broke",
    (row?.findings ?? []).length > 0 && (row?.findings ?? []).every((f) => Boolean(f.claimId)),
    `${row?.findings.filter((f) => f.claimId).length}/${row?.findings.length} findings carry a claim id`
  );
  check(
    "revalidate",
    "broken claims moved the aspect they were pinned to",
    (row?.claims.broken ?? 0) > 0,
    `${row?.claims.broken} of ${row?.claims.total} claims broken, ${row?.claims.holds} still hold`
  );

  /* Write-back */
  check(
    "write-back",
    "a drift note is in the catalog",
    Boolean(row?.receipt?.written && row.receipt.documentUrn),
    row?.receipt?.documentUrn ?? row?.receipt?.error ?? "not written"
  );
  check(
    "write-back",
    "the runbook's assertion is now FAILING in DataHub",
    Boolean(row?.structured?.assertions.some((a) => a.result === "FAILURE")),
    row?.structured?.assertions.map((a) => `${a.urn.slice(-12)}=${a.result}`).join(", ") || "no assertion written"
  );
  check(
    "write-back",
    "the specific catalog change is recorded as structured state",
    Boolean(row?.structured?.properties.some((p) => p.driftValues > 0)),
    row?.structured?.properties.map((p) => `${p.driftValues} drift value(s)`).join(", ") || "none"
  );
  check(
    "write-back",
    "drifted datasets are tagged",
    (row?.native?.tagged.length ?? 0) > 0,
    `${row?.native?.tagged.length ?? 0} tagged`
  );
  check(
    "write-back",
    "an incident is raised and assigned to the current owner",
    Boolean(row?.native?.incidents.length) && row!.native!.incidents.every((i) => i.assignees.length > 0),
    row?.native?.incidents.map((i) => `${i.urn.slice(-12)} → ${i.assignees.join(", ") || "unassigned"}`).join("; ") ||
      "no incident"
  );

  /* The proposed correction */
  const proposal = row?.proposal;
  check(
    "propose",
    "a correction is proposed for the renamed column",
    Boolean(proposal?.edits.some((e) => e.kind === "column-rename" && e.to === "net_revenue_usd")),
    proposal?.edits.map((e) => `${e.from}→${e.to}`).join(", ") || "no edits"
  );
  check(
    "propose",
    "a correction is proposed for the departed owner",
    Boolean(proposal?.edits.some((e) => e.kind === "owner-update")),
    proposal?.edits.find((e) => e.kind === "owner-update")
      ? `${proposal!.edits.find((e) => e.kind === "owner-update")!.from} → ${
          proposal!.edits.find((e) => e.kind === "owner-update")!.to
        }`
      : "none"
  );
  check(
    "propose",
    "the deprecated table is repointed at its named replacement",
    Boolean(proposal?.edits.some((e) => e.kind === "dataset-replacement")),
    proposal?.edits.find((e) => e.kind === "dataset-replacement")?.to ?? "none"
  );
  check(
    "propose",
    "the correction comes out as a reviewable diff",
    Boolean(proposal?.diff && proposal.diff.includes("net_revenue_usd")),
    proposal?.diff ? `${proposal.diff.split("\n").length} diff lines` : "no diff"
  );
  check(
    "propose",
    "the review goes to whoever owns the data now",
    (proposal?.reviewers.length ?? 0) > 0,
    proposal?.reviewers.join(", ") || "nobody"
  );
}

/* ── Main ─────────────────────────────────────────────────────────────── */

async function main() {
  if (isDemoMode()) {
    console.error("DEMO_MODE is set. This proves the loop against a real DataHub, so unset it.");
    process.exit(1);
  }

  const started = new Date().toISOString();
  say("\n1/7  DataHub");
  if (!(await ensureDataHub())) return finish(started, null, [], null);

  say("\n2/7  sample catalog");
  if (!(await ingestCatalog())) return finish(started, null, [], null);

  say("\n3/7  capture a runbook against it");
  await capture();

  say("\n4/7  validate — should be clean");
  const before = await sweep();
  assertClean(before, "validate");

  say("\n5/7  break the catalog for real");
  const changes = await breakCatalog();
  check("break", "breaking changes applied through DataHub's own APIs", changes.length === 3, `${changes.length}/3 applied`);
  say("    waiting for DataHub to index the changes…");
  await new Promise((r) => setTimeout(r, 25_000));

  say("\n6/7  revalidate — should catch all of it");
  const after = await sweep();
  assertCaught(after);

  let restored: SweepResult | null = null;
  if (keepBroken) {
    say("\n7/7  leaving the catalog broken (--keep-broken). Look at it in the DataHub UI:");
    for (const c of changes) say(`     ${entityUrl(c.urn)}`);
  } else {
    say("\n7/7  restore the catalog and revalidate — should go green again");
    await restoreCatalog();
    await new Promise((r) => setTimeout(r, 25_000));
    restored = await sweep();
    assertClean(restored, "restore");
  }

  finish(started, before, changes, after, restored);
}

function finish(
  started: string,
  before: SweepResult | null,
  changes: Change[],
  after: SweepResult | null,
  restored: SweepResult | null = null
): void {
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.length - passed;

  const proposal = after?.rows[0]?.proposal ?? null;
  if (proposal) {
    mkdirSync(path.join(process.cwd(), "proposals"), { recursive: true });
    writeFileSync(path.join(process.cwd(), "proposals", `${proposal.runbookId}.md`), proposalToMarkdown(proposal));
  }

  const receipts = {
    startedAt: started,
    finishedAt: new Date().toISOString(),
    gms: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
    catalog: "the sample Northbeam catalog ingested by scripts/seed_datahub.py",
    method:
      "A runbook was captured against the live catalog and snapshotted through the same code path the app uses. " +
      "The catalog was then changed through DataHub's own write APIs: a column renamed in schemaMetadata, a table " +
      "deprecated via updateDeprecation, an owner removed via the MCP server's remove_owners. The decay engine was " +
      "told none of it.",
    breakingChanges: changes,
    checks,
    summary: { total: checks.length, passed, failed },
    validations: {
      before: before && { severity: before.rows[0]?.severity, claims: before.rows[0]?.claims, findings: before.rows[0]?.findings },
      after: after && {
        severity: after.rows[0]?.severity,
        claims: after.rows[0]?.claims,
        findings: after.rows[0]?.findings,
        documentUrn: after.rows[0]?.receipt?.documentUrn ?? null,
        assertions: after.rows[0]?.structured?.assertions ?? [],
        structuredProperties: after.rows[0]?.structured?.properties ?? [],
        incidents: after.rows[0]?.native?.incidents ?? [],
        tagged: after.rows[0]?.native?.tagged ?? [],
        proposal: proposal && {
          edits: proposal.edits,
          unresolved: proposal.unresolved,
          reviewers: proposal.reviewers,
          diff: proposal.diff,
        },
      },
      afterRestore: restored && { severity: restored.rows[0]?.severity, claims: restored.rows[0]?.claims },
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(RECEIPTS, JSON.stringify(receipts, null, 2));

  if (json) {
    console.log(JSON.stringify(receipts, null, 2));
  } else {
    console.log(`\n${"─".repeat(72)}`);
    console.log(`${failed === 0 ? "PASS" : "FAIL"} — ${passed}/${checks.length} checks passed`);
    for (const c of checks.filter((c) => !c.passed)) console.log(`  ✗ [${c.phase}] ${c.what}: ${c.detail}`);
    console.log(`\nwrote ${path.relative(process.cwd(), RECEIPTS)}`);
    if (proposal) console.log(`wrote proposals/${proposal.runbookId}.md`);
  }

  if (!keepBroken) deleteHandoff("prove-monthly-revenue-close");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
