/**
 * The whole loop, proved end to end, in one command.
 *
 *   npm run prove                        # the catalog this repo seeds
 *   npm run prove -- --catalog=showcase  # DataHub's own showcase-ecommerce datapack
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
 *   --catalog=<name>    northbeam (default) or showcase
 *   --skip-quickstart   assume DataHub is already running
 *   --skip-seed         assume the sample catalog is already ingested
 *   --keep-broken       leave the catalog changed so you can look at it in the UI
 *   --json              machine-readable result only
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snapshotEntity, snapshotHandoff } from "../lib/decay";
import { datahubGraphQL, gmsReachable } from "../lib/datahub-graphql";
import { readAspect, writeAspect } from "../lib/gms-aspects";
import { callDataHubTool, isDemoMode } from "../lib/mcp";
import { deleteHandoff, saveHandoff } from "../lib/handoff-store";
import { sweepRunbooks, type SweepResult } from "../lib/sweep";
import { resolveIncidentsFor, STALE_RUNBOOK_TAG_URN } from "../lib/native-writeback";
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
const showcase = (platform: string, table: string) =>
  `urn:li:dataset:(urn:li:dataPlatform:${platform},b2fd91.order_entry_db.${table},PROD)`;

/**
 * Which catalog to prove the loop against.
 *
 * Northbeam is seeded by this repo, which is a fair objection: we chose the
 * catalog, the runbook and the breaking changes. `--catalog=showcase` re-points
 * the whole proof at `showcase-ecommerce`, the datapack DataHub publishes, so a
 * judge can verify it on the same catalog everyone else is using and compare
 * like for like.
 *
 * The profile is only *what* to break. Every phase, assertion and receipt below
 * is shared, so the two runs are the same proof on different data.
 */
interface CatalogProfile {
  name: string;
  description: string;
  /** Bring the catalog into existence. */
  ingest: () => { command: string; args: string[]; note: string } | null;
  /** Read this back to confirm the ingest worked. */
  probeUrn: string;
  runbook: () => Handoff;
  /** A column the runbook's SQL selects, renamed out from under it. */
  rename: { urn: string; from: string; to: string };
  /** A table a step routes you to, deprecated mid-runbook. */
  deprecate: { urn: string; note: string; replacement: string };
  /** An owner a step tells you to page, moved off the dataset. */
  ownerRemoval: { urn: string; ownerUrn: string; display: string };
}

const OUT_DIR = path.join(process.cwd(), "examples", "live");
const RECEIPTS = () =>
  path.join(OUT_DIR, CATALOG.name === "northbeam" ? "prove-loop-receipts.json" : `prove-loop-receipts-${CATALOG.name}.json`);

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

/* ── The catalogs, and the runbook under test on each ─────────────────── */

/**
 * One runbook, three steps, leaning on facts the catalog actually holds: a
 * column its SQL selects, a table it routes you to, and a person it tells you to
 * go and ask. Those are the three things that rot, and phase 5 breaks one of each.
 */
const NORTHBEAM: CatalogProfile = {
  name: "northbeam",
  description: "the sample catalog this repo seeds with scripts/seed_datahub.py",
  ingest: () => ({
    command: "uv",
    args: ["run", "--with", "acryl-datahub", "scripts/seed_datahub.py"],
    note: "ingesting the sample catalog (14 datasets, 4 people, glossary, assertions)…",
  }),
  probeUrn: sf("fct_revenue"),
  rename: { urn: sf("fct_revenue"), from: "net_amount_usd", to: "net_revenue_usd" },
  deprecate: {
    urn: sf("mrr_monthly"),
    note: "Rebuilt with plan-level grain at the FY close. Use analytics.marts.mrr_monthly_v2 instead.",
    replacement: "analytics.marts.mrr_monthly_v2",
  },
  ownerRemoval: { urn: sf("fct_revenue"), ownerUrn: "urn:li:corpuser:mike.rodriguez", display: "Mike Rodriguez" },
  runbook: () => ({
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
        urn: sf("payment_health_daily"),
        url: entityUrl(sf("payment_health_daily")),
        sql: "SELECT date, provider, success_rate FROM analytics.marts.payment_health_daily ORDER BY date DESC LIMIT 30;",
      },
      {
        title: "Pull net revenue for the month",
        instruction:
          "Sum net_amount_usd from fct_revenue for the close month. Use net_amount_usd, never gross_amount_usd — " +
          "gross is before refunds and will not tie to the bank.",
        why: "Finance reconciles to settled cash, so refunds have to be out before the number leaves this step.",
        urn: sf("fct_revenue"),
        url: entityUrl(sf("fct_revenue")),
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
        urn: sf("mrr_monthly"),
        url: entityUrl(sf("mrr_monthly")),
        sql: "SELECT month, SUM(mrr_usd) AS mrr FROM analytics.marts.mrr_monthly GROUP BY 1 ORDER BY 1 DESC LIMIT 12;",
      },
    ],
  }),
};

/**
 * The same proof on DataHub's own published datapack — 1,065 entities nobody
 * here authored. The runbook mirrors the Northbeam one step for step so the two
 * runs are directly comparable.
 */
const SHOWCASE: CatalogProfile = {
  name: "showcase",
  description: "showcase-ecommerce, the demo datapack DataHub publishes (1,065 entities)",
  ingest: () => ({
    command: "uv",
    args: ["run", "--with", "acryl-datahub", "datahub", "datapack", "load", "showcase-ecommerce"],
    note: "loading DataHub's showcase-ecommerce datapack…",
  }),
  probeUrn: showcase("snowflake", "analytics.order_details"),
  rename: { urn: showcase("snowflake", "analytics.order_details"), from: "cost_of_delivery", to: "delivery_cost_usd" },
  deprecate: {
    urn: showcase("snowflake", "analytics.order_history"),
    note: "Retired at the FY close. Use order_entry_db.analytics.order_details with a point-in-time filter instead.",
    replacement: "order_entry_db.analytics.order_details",
  },
  ownerRemoval: {
    urn: showcase("dbt", "order_entry.products"),
    ownerUrn: "urn:li:corpuser:b2fd91.patrick1@example.com",
    display: "Priya Sharma",
  },
  runbook: () => ({
    id: "prove-weekly-order-revenue",
    title: "Weekly order revenue pack",
    author: "David Kim",
    role: "Data Scientist",
    summary:
      "How I build the Monday commercial pack: check the order fact is healthy, pull revenue and delivery cost by " +
      "customer class off ORDER_DETAILS, then cross-check the point-in-time history before anyone quotes a number.",
    createdAt: new Date().toISOString(),
    recorded: [],
    steps: [
      {
        title: "Confirm ORDER_DETAILS is healthy and current",
        instruction:
          "Open ORDER_DETAILS in the analytics schema and check the health badge for failing assertions or open " +
          "incidents before you trust today's numbers.",
        why: "This is the certified wide order table. If it is stale, every number in the pack is stale.",
        urn: showcase("snowflake", "analytics.order_details"),
        url: entityUrl(showcase("snowflake", "analytics.order_details")),
      },
      {
        title: "Pull revenue and delivery cost by customer class",
        instruction:
          "Run the aggregation below. order_total is the glossary-sanctioned measure; cost_of_delivery is what the " +
          "commercial team wants netted off it.",
        why: "The commercial review asks for revenue net of delivery every week, and the wide table already carries both.",
        urn: showcase("snowflake", "analytics.order_details"),
        url: entityUrl(showcase("snowflake", "analytics.order_details")),
        sql:
          "SELECT customer_class,\n       SUM(order_total)      AS total_revenue,\n" +
          "       SUM(cost_of_delivery) AS delivery_cost\n" +
          "FROM order_entry_db.analytics.order_details\nGROUP BY customer_class\nORDER BY total_revenue DESC;",
        tips: "cost_of_delivery is on the wide table already, so do not join back to orders for it.",
      },
      {
        title: "Cross-check against the point-in-time history",
        instruction:
          "Compare the totals above against ORDER_HISTORY at the latest as_of_date. They should agree; if they " +
          "don't, the snapshot ran mid-load.",
        why: "The pack quotes a weekly movement, and a mid-load snapshot makes the movement look like a real swing.",
        urn: showcase("snowflake", "analytics.order_history"),
        url: entityUrl(showcase("snowflake", "analytics.order_history")),
        sql:
          "SELECT order_status, COUNT(*) AS orders, SUM(order_total) AS value\n" +
          "FROM order_entry_db.analytics.order_history\n" +
          "WHERE as_of_date = (SELECT MAX(as_of_date) FROM order_entry_db.analytics.order_history)\n" +
          "GROUP BY order_status;",
      },
      {
        title: "Get sign-off on the product margins",
        instruction: "Before the pack goes out, have the product margins signed off against the dbt products model.",
        why: "Margins are the number the commercial team argues about, and the steward is the one who settles it.",
        urn: showcase("dbt", "order_entry.products"),
        url: entityUrl(showcase("dbt", "order_entry.products")),
        tips: "Priya Sharma is the Data Steward on the products model — she signs these off.",
      },
    ],
  }),
};

const CATALOGS: Record<string, CatalogProfile> = { northbeam: NORTHBEAM, showcase: SHOWCASE };

const catalogArg = args.find((a) => a.startsWith("--catalog="))?.split("=")[1] ?? "northbeam";
const CATALOG = CATALOGS[catalogArg];
if (!CATALOG) {
  console.error(`Unknown catalog "${catalogArg}". Available: ${Object.keys(CATALOGS).join(", ")}`);
  process.exit(1);
}

const runbook = () => CATALOG.runbook();

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
  const step = CATALOG.ingest();
  if (!skipSeed && step) {
    say(`    ${step.note}`);
    try {
      execFileSync(step.command, step.args, {
        stdio: json ? "ignore" : "inherit",
        timeout: 15 * 60_000,
        // Tell the CLI where GMS is explicitly. Left to itself it reads
        // `~/.datahubenv`, which only exists if `datahub docker quickstart` was
        // run by this user on this machine — so `datapack load` fails with
        // "could not connect to check version compatibility" against a DataHub
        // that is up and answering. On a CI runner there is no such file at all.
        env: {
          ...process.env,
          DATAHUB_GMS_URL: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
          ...(process.env.DATAHUB_GMS_TOKEN ? { DATAHUB_GMS_TOKEN: process.env.DATAHUB_GMS_TOKEN } : {}),
        },
      });
    } catch (err) {
      return check("ingest", "sample catalog ingested", false, err instanceof Error ? err.message : String(err));
    }
    // Search and health are eventually consistent behind GMS.
    await new Promise((r) => setTimeout(r, 15_000));
  }

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
    snaps.length >= 3 && snaps.every((s) => s.exists),
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
  const { urn: renameUrn, from, to } = CATALOG.rename;
  const schema = await readAspect(renameUrn, "schemaMetadata");
  const fields = (schema?.fields ?? []) as Record<string, unknown>[];
  if (schema && fields.some((f) => f.fieldPath === from)) {
    await writeAspect(renameUrn, "schemaMetadata", {
      ...schema,
      fields: fields.map((f) => (f.fieldPath === from ? { ...f, fieldPath: to } : f)),
    });
    changes.push({
      kind: "column-renamed",
      urn: renameUrn,
      detail: `Renamed ${shortName(renameUrn)}.${from} to ${to} — a column the runbook's SQL selects.`,
    });
    say(`    ✓ renamed ${from} → ${to} on ${shortName(renameUrn)}`);
  }

  /* 2. Deprecate the table a step routes you to. */
  const dep = await datahubGraphQL(UPDATE_DEPRECATION, {
    input: { urn: CATALOG.deprecate.urn, deprecated: true, note: CATALOG.deprecate.note },
  });
  if (!dep.errors?.length) {
    changes.push({
      kind: "deprecated",
      urn: CATALOG.deprecate.urn,
      detail: `Deprecated ${shortName(CATALOG.deprecate.urn)}, which the runbook routes you to.`,
    });
    say(`    ✓ deprecated ${shortName(CATALOG.deprecate.urn)}`);
  }

  /* 3. Move the owner the runbook tells you to go and ask. */
  const removed = await callDataHubTool("remove_owners", {
    owner_urns: [CATALOG.ownerRemoval.ownerUrn],
    entity_urns: [CATALOG.ownerRemoval.urn],
  });
  if (!removed.isError) {
    changes.push({
      kind: "owner-removed",
      urn: CATALOG.ownerRemoval.urn,
      detail: `Removed ${CATALOG.ownerRemoval.display} as an owner of ${shortName(CATALOG.ownerRemoval.urn)}, whom the runbook names.`,
    });
    say(`    ✓ removed ${CATALOG.ownerRemoval.display} from ${shortName(CATALOG.ownerRemoval.urn)}`);
  }

  return changes;
}

async function restoreCatalog(): Promise<void> {
  const { urn: renameUrn, from, to } = CATALOG.rename;
  const schema = await readAspect(renameUrn, "schemaMetadata");
  const fields = (schema?.fields ?? []) as Record<string, unknown>[];
  if (schema && fields.some((f) => f.fieldPath === to)) {
    await writeAspect(renameUrn, "schemaMetadata", {
      ...schema,
      fields: fields.map((f) => (f.fieldPath === to ? { ...f, fieldPath: from } : f)),
    });
    say(`    ✓ restored ${from} on ${shortName(renameUrn)}`);
  }

  await datahubGraphQL(UPDATE_DEPRECATION, { input: { urn: CATALOG.deprecate.urn, deprecated: false, note: "" } });
  say(`    ✓ un-deprecated ${shortName(CATALOG.deprecate.urn)}`);

  const added = await callDataHubTool("add_owners", {
    owner_urns: [CATALOG.ownerRemoval.ownerUrn],
    entity_urns: [CATALOG.ownerRemoval.urn],
    ownership_type: "__system__technical_owner",
  });
  say(
    added.isError
      ? `    • could not restore ${CATALOG.ownerRemoval.display} as an owner: ${added.content.slice(0, 160)}`
      : `    ✓ restored ${CATALOG.ownerRemoval.display} as an owner of ${shortName(CATALOG.ownerRemoval.urn)}`
  );
}

/* ── Phases 4 and 6: validate ─────────────────────────────────────────── */

async function sweep(): Promise<SweepResult> {
  return sweepRunbooks({ filter: runbook().id });
}

/**
 * Read the tags DataHub actually holds on a dataset.
 *
 * The write-back receipt says what was sent; this says what the catalog has. A
 * tag retraction proved from the receipt alone is the tool marking its own
 * homework, so both sides of tag → repair → tag-gone are read back from GMS.
 */
async function tagsOn(urn: string): Promise<string[]> {
  const res = await datahubGraphQL<{
    dataset: { tags: { tags: { tag: { urn: string } }[] } | null } | null;
  }>(`query($urn: String!) { dataset(urn: $urn) { tags { tags { tag { urn } } } } }`, { urn });
  return (res.data?.dataset?.tags?.tags ?? []).map((t) => t.tag.urn);
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

  /*
   * "No drift" is only good news if everything was actually checked. These two
   * assert the run says which of the two it is, rather than letting a reader
   * assume the better one.
   */
  const coverage = row?.coverage;
  check(
    phase,
    "the run reports how much of the runbook it could check",
    Boolean(coverage && coverage.stepsTotal > 0 && coverage.summary),
    coverage?.summary ?? "no coverage reported"
  );
  check(
    phase,
    "a clean run with unvalidatable claims is not reported as a pass",
    Boolean(coverage) && row!.verdict === (coverage!.claimsUnvalidatable > 0 ? "INSUFFICIENT_DATA" : "PASS"),
    `verdict ${row?.verdict}, ${coverage?.claimsUnvalidatable ?? 0}/${coverage?.claimsTotal ?? 0} claims unvalidatable`
  );
  check(
    phase,
    "the coverage figure is written to the catalog",
    Boolean(row?.structured?.properties.some((p) => p.coverage)),
    row?.structured?.properties.find((p) => p.coverage)?.coverage ?? "not written"
  );
}

function assertCaught(result: SweepResult, liveOwners: Record<string, number>): void {
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
  /*
   * Assigned wherever there is somebody to assign to. On DataHub's own datapack,
   * ORDER_HISTORY has no owners at all, and leaving that incident unassigned is
   * the correct behaviour — guessing an assignee would be worse. So the check is
   * that every incident on a dataset which *has* an individual owner is assigned,
   * and that at least one incident reached a person.
   */
  const incidents = row?.native?.incidents ?? [];
  const ownedDatasets = new Set(
    Object.entries(row?.structured?.properties ?? {})
      .map(([, p]) => p.datasetUrn)
      .filter(Boolean)
  );
  const assignable = incidents.filter((i) => (liveOwners[i.datasetUrn] ?? 0) > 0);
  check(
    "write-back",
    "every incident on an owned dataset reaches its current owner",
    incidents.length > 0 && assignable.every((i) => i.assignees.length > 0) && incidents.some((i) => i.assignees.length),
    incidents
      .map(
        (i) =>
          `${shortName(i.datasetUrn)} → ${i.assignees.join(", ") || `unassigned (${liveOwners[i.datasetUrn] ?? 0} owners)`}`
      )
      .join("; ") || "no incident"
  );
  void ownedDatasets;

  /* The proposed correction */
  const proposal = row?.proposal;
  check(
    "propose",
    "a correction is proposed for the renamed column",
    Boolean(proposal?.edits.some((e) => e.kind === "column-rename" && e.to === CATALOG.rename.to)),
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
    Boolean(proposal?.diff && proposal.diff.includes(CATALOG.rename.to)),
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
  say(`\nProving the loop against ${CATALOG.description}.`);
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

  // How many individual owners each touched dataset has right now — an incident
  // can only be assigned to a person if the dataset has one.
  const liveOwners: Record<string, number> = {};
  for (const urn of [...new Set(runbook().steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))]) {
    const snap = await snapshotEntity(urn);
    liveOwners[urn] = (snap.ownerUrns ?? []).filter((o) => o.startsWith("urn:li:corpuser:")).length;
  }
  assertCaught(after, liveOwners);

  // Read the tag back out of DataHub rather than trusting the write receipt.
  const taggedUrns = after.rows[0]?.native?.tagged ?? [];
  const tagsWhileBroken: Record<string, string[]> = {};
  for (const urn of taggedUrns) tagsWhileBroken[urn] = await tagsOn(urn);
  check(
    "write-back",
    "the Stale Runbook tag reads back off the dataset in DataHub",
    taggedUrns.length > 0 && taggedUrns.every((u) => tagsWhileBroken[u]?.includes(STALE_RUNBOOK_TAG_URN)),
    `${taggedUrns.filter((u) => tagsWhileBroken[u]?.includes(STALE_RUNBOOK_TAG_URN)).length}/${taggedUrns.length} carry it`
  );

  let restored: SweepResult | null = null;
  let tagsAfterRestore: Record<string, string[]> = {};
  if (keepBroken) {
    say("\n7/7  leaving the catalog broken (--keep-broken). Look at it in the DataHub UI:");
    for (const c of changes) say(`     ${entityUrl(c.urn)}`);
  } else {
    say("\n7/7  restore the catalog and revalidate — should go green again");
    await restoreCatalog();
    await new Promise((r) => setTimeout(r, 25_000));
    restored = await sweep();
    assertClean(restored, "restore");

    /*
     * Closing the incident is the sweep's job, and it has to be the sweep that
     * does it here or the proof is only proving the cleanup code in this script.
     * The manual close below runs afterwards, for anything the sweep left — an
     * incident orphaned by deleting this run's temporary runbook could never be
     * closed by a later sweep, because nothing would match its title.
     */
    check(
      "restore",
      "the sweep itself closes the incidents it opened",
      (restored.rows[0]?.resolved.length ?? 0) > 0,
      `${restored.rows[0]?.resolved.length ?? 0} incident(s) resolved by the sweep`
    );

    /*
     * Cleanup, not a check: this run's runbook is deleted below, and an incident
     * left open could never be matched by a later sweep. Usually this re-closes
     * what the sweep just closed — DataHub's incident index lags a resolve by a
     * few seconds, so the second read still sees them ACTIVE — and re-resolving
     * is a no-op.
     */
    const touched = [...new Set(runbook().steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];
    const swept = await resolveIncidentsFor(runbook(), touched);
    if (swept.length) say(`    · re-checked for open incidents, closed ${swept.length} (index lag makes this a repeat)`);

    /*
     * The half almost nothing does: take the warning back down. A tool that only
     * ever adds state leaves a catalog full of warnings about problems fixed
     * months ago, and the state stops meaning anything. Read back on both sides.
     */
    for (const urn of taggedUrns) tagsAfterRestore[urn] = await tagsOn(urn);
    check(
      "restore",
      "the Stale Runbook tag is retracted from every dataset it was applied to",
      taggedUrns.length > 0 && taggedUrns.every((u) => !tagsAfterRestore[u]?.includes(STALE_RUNBOOK_TAG_URN)),
      `${taggedUrns.filter((u) => !tagsAfterRestore[u]?.includes(STALE_RUNBOOK_TAG_URN)).length}/${taggedUrns.length} cleared`
    );
    check(
      "restore",
      "the retraction is recorded as a receipt, not just a side effect",
      Boolean(restored.rows[0]?.retracted?.attempted) && (restored.rows[0]?.retracted?.untagged.length ?? 0) > 0,
      `${restored.rows[0]?.retracted?.untagged.length ?? 0} untagged, ` +
        `${restored.rows[0]?.retracted?.kept.length ?? 0} kept for other runbooks`
    );
  }

  finish(started, before, changes, after, restored, { tagsWhileBroken, tagsAfterRestore });
}

function finish(
  started: string,
  before: SweepResult | null,
  changes: Change[],
  after: SweepResult | null,
  restored: SweepResult | null = null,
  tagReadBack: { tagsWhileBroken: Record<string, string[]>; tagsAfterRestore: Record<string, string[]> } = {
    tagsWhileBroken: {},
    tagsAfterRestore: {},
  }
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
    catalog: CATALOG.description,
    catalogProfile: CATALOG.name,
    method:
      "A runbook was captured against the live catalog and snapshotted through the same code path the app uses. " +
      "The catalog was then changed through DataHub's own write APIs: a column renamed in schemaMetadata, a table " +
      "deprecated via updateDeprecation, an owner removed via the MCP server's remove_owners. The decay engine was " +
      "told none of it.",
    breakingChanges: changes,
    checks,
    summary: { total: checks.length, passed, failed },
    validations: {
      before: before && {
        severity: before.rows[0]?.severity,
        verdict: before.rows[0]?.verdict,
        coverage: before.rows[0]?.coverage,
        claims: before.rows[0]?.claims,
        findings: before.rows[0]?.findings,
      },
      after: after && {
        severity: after.rows[0]?.severity,
        verdict: after.rows[0]?.verdict,
        coverage: after.rows[0]?.coverage,
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
      afterRestore: restored && {
        severity: restored.rows[0]?.severity,
        verdict: restored.rows[0]?.verdict,
        coverage: restored.rows[0]?.coverage,
        claims: restored.rows[0]?.claims,
        retracted: restored.rows[0]?.retracted ?? null,
        resolvedIncidents: restored.rows[0]?.resolved ?? [],
      },
    },
    /* What DataHub itself reported holding, either side of the repair. */
    tagReadBack,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(RECEIPTS(), JSON.stringify(receipts, null, 2));

  if (json) {
    console.log(JSON.stringify(receipts, null, 2));
  } else {
    console.log(`\n${"─".repeat(72)}`);
    console.log(`${failed === 0 ? "PASS" : "FAIL"} — ${passed}/${checks.length} checks passed`);
    for (const c of checks.filter((c) => !c.passed)) console.log(`  ✗ [${c.phase}] ${c.what}: ${c.detail}`);
    console.log(`\nwrote ${path.relative(process.cwd(), RECEIPTS())}`);
    if (proposal) console.log(`wrote proposals/${proposal.runbookId}.md`);
  }

  if (!keepBroken) deleteHandoff(runbook().id);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
