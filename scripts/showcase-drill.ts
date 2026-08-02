/**
 * The decay drill: prove the headline loop on a catalog we didn't build.
 *
 *   npm run showcase:drill receipts  # the whole cycle, captured to examples/live/
 *
 * or step through it by hand:
 *
 *   npm run showcase:drill record    # write 3 runbooks, snapshot live DataHub
 *   npm run validate                 # → all clean
 *   npm run showcase:drill break     # make 3 REAL breaking changes to the catalog
 *   npm run validate                 # → drift found, notes + incidents written, exit 2
 *   npm run showcase:drill restore   # put the catalog back
 *
 * The point is that nothing here is staged inside instaboard. The runbooks point
 * at `showcase-ecommerce`, DataHub's own demo datapack. `break` then does to that
 * catalog what a real schema migration does. It drops a column a runbook's SQL
 * selects, deprecates a table a runbook routes people to, and moves an owner a
 * runbook tells you to page, all through DataHub's own write APIs. Nobody tells
 * the decay engine. It re-reads the catalog and works out what happened.
 *
 * `record` snapshots through the same `snapshotHandoff` the app uses, so the
 * baseline is whatever live DataHub actually returned, not a hand-written fixture.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snapshotHandoff } from "../lib/decay";
import { datahubGraphQL } from "../lib/datahub-graphql";
import { readAspect, writeAspect } from "../lib/gms-aspects";
import { callDataHubTool, isDemoMode } from "../lib/mcp";
import { saveHandoff, deleteHandoff } from "../lib/handoff-store";
import { sweepRunbooks } from "../lib/sweep";
import { STALE_RUNBOOK_TAG_URN } from "../lib/native-writeback";
import type { Handoff } from "../lib/types";

/* ── The showcase entities the runbooks lean on ───────────────────────── */

const ORDER_DETAILS =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)";
const ORDER_HISTORY =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_history,PROD)";
const ORDER_ITEMS =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.order_items,PROD)";
const DBT_PRODUCTS =
  "urn:li:dataset:(urn:li:dataPlatform:dbt,b2fd91.order_entry_db.order_entry.products,PROD)";
const PROMOTIONS =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.order_entry.promotions,PROD)";

/** The owner the products runbook tells you to contact, a Data Steward in the pack. */
const PRIYA_SHARMA = "urn:li:corpuser:b2fd91.patrick1@example.com";

const GMS = () => process.env.DATAHUB_GMS_URL || "http://localhost:8080";
const UI = () => process.env.DATAHUB_UI_URL || "http://localhost:9002";
const entityUrl = (urn: string) => `${UI()}/dataset/${encodeURIComponent(urn)}`;

const MANIFEST = path.join(process.cwd(), "examples", "live", "showcase-break-manifest.json");

/* ── The runbooks ─────────────────────────────────────────────────────── */

function runbooks(): Handoff[] {
  const recordedAt = "2026-08-02T12:00:00.000Z";

  return [
    {
      id: "showcase-weekly-order-revenue",
      title: "Weekly order revenue pack for the commercial review",
      author: "David Kim",
      role: "Data Scientist (Data Steward, ORDER_DETAILS)",
      summary:
        "How I build the Monday commercial pack: check the order fact is healthy, pull revenue and delivery cost by customer class off ORDER_DETAILS, then cross-check the line-item detail before anyone quotes the number.",
      createdAt: recordedAt,
      steps: [
        {
          title: "Confirm ORDER_DETAILS is healthy and current",
          instruction:
            "Open ORDER_DETAILS in the analytics schema. Check the health badge for failing assertions or open incidents, and confirm the Data Freshness SLA property still reads Daily before you trust today's numbers.",
          why: "This is the certified wide order table. It carries the Most Queried tag and a 97.5 quality score. If it is stale, every number in the pack is stale, and I would rather find that out here than in the meeting.",
          urn: ORDER_DETAILS,
          url: entityUrl(ORDER_DETAILS),
          tips: "ORDER_DETAILS_REPLICA has the same 55 columns and no owner. Do not use it. It exists because somebody cloned the table and left.",
        },
        {
          title: "Pull revenue and delivery cost by customer class",
          instruction:
            "Run the aggregation below. order_total is the glossary-sanctioned measure; cost_of_delivery is what the commercial team wants netted off it.",
          why: "The Revenue by Customer Class glossary term prescribes grouping on customer_class and aggregating order_total. Deriving it any other way produces a number finance will dispute.",
          urn: ORDER_DETAILS,
          url: entityUrl(ORDER_DETAILS),
          sql: "SELECT customer_class,\n       SUM(order_total)      AS total_revenue,\n       SUM(cost_of_delivery) AS delivery_cost,\n       COUNT(DISTINCT order_id) AS order_count\nFROM order_entry_db.analytics.order_details\nWHERE order_date >= DATEADD(day, -7, CURRENT_DATE)\nGROUP BY customer_class\nORDER BY total_revenue DESC;",
          tips: "cost_of_delivery is on the wide table already, so do not join back to orders for it.",
        },
        {
          title: "Cross-check against the line items",
          instruction:
            "Reconcile the weekly total against ORDER_ITEMS. If unit_price × quantity does not land within a rounding tolerance of the order_total sum, something upstream double-counted.",
          why: "We shipped a wrong number once because a retry duplicated line items. Reconciling takes two minutes and has caught it twice since.",
          urn: ORDER_ITEMS,
          url: entityUrl(ORDER_ITEMS),
          sql: "SELECT SUM(unit_price * quantity) AS line_item_total\nFROM order_entry_db.order_entry.order_items;",
        },
      ],
      recorded: [
        { url: entityUrl(ORDER_DETAILS), urn: ORDER_DETAILS, title: "ORDER_DETAILS", note: "Certified wide table. Start here." },
        { url: entityUrl(ORDER_ITEMS), urn: ORDER_ITEMS, title: "ORDER_ITEMS", note: "Reconciliation source." },
      ],
      datahub: { saved: false },
    },
    {
      id: "showcase-order-status-backfill",
      title: "Monthly order-status backfill check",
      author: "Julia Novak",
      role: "Data Quality Engineer (Data Steward, ORDER_DETAILS)",
      summary:
        "The month-end check that order statuses settled correctly: read the as-of snapshots out of ORDER_HISTORY, compare against the live order state, and flag anything that moved after close.",
      createdAt: recordedAt,
      steps: [
        {
          title: "Read the month-end snapshots from ORDER_HISTORY",
          instruction:
            "Query ORDER_HISTORY for the last as_of_date in the closing month. This table holds the incremental history, one row per order per snapshot date, so filter to a single as_of_date or you will count every order once per day it existed.",
          why: "Finance closes on the snapshot, not on live state. If we compare against live orders we will 'find' discrepancies that are just legitimate post-close movement.",
          urn: ORDER_HISTORY,
          url: entityUrl(ORDER_HISTORY),
          sql: "SELECT order_status, COUNT(*) AS orders, SUM(order_total) AS value\nFROM order_entry_db.analytics.order_history\nWHERE as_of_date = (SELECT MAX(as_of_date) FROM order_entry_db.analytics.order_history)\nGROUP BY order_status;",
        },
        {
          title: "Compare against the live order state",
          instruction:
            "Run the same grouping against ORDER_DETAILS and diff the two. Anything that changed status after the snapshot date is what the commercial team needs to see.",
          why: "The whole point of the check is the delta. ORDER_DETAILS is the live certified view; ORDER_HISTORY is what we told finance last month.",
          urn: ORDER_DETAILS,
          url: entityUrl(ORDER_DETAILS),
          sql: "SELECT order_status, COUNT(*) AS orders, SUM(order_total) AS value\nFROM order_entry_db.analytics.order_details\nGROUP BY order_status;",
        },
      ],
      recorded: [
        { url: entityUrl(ORDER_HISTORY), urn: ORDER_HISTORY, title: "ORDER_HISTORY", note: "Snapshot table. Always filter as_of_date." },
        { url: entityUrl(ORDER_DETAILS), urn: ORDER_DETAILS, title: "ORDER_DETAILS", note: "Live comparison." },
      ],
      datahub: { saved: false },
    },
    {
      id: "showcase-promotion-margin-review",
      title: "Promotion margin review before a campaign launch",
      author: "Karen Okonkwo",
      role: "Technical Owner, PowerBI ORDER_DETAILS",
      summary:
        "What I check before signing off a promotion: the campaign window and cost in PROMOTIONS, then the product catalogue for list vs min price, so we know the floor before marketing commits a discount.",
      createdAt: recordedAt,
      steps: [
        {
          title: "Read the campaign window and cost",
          instruction:
            "Open PROMOTIONS and pull promotion_start_date, promotion_end_date and promotion_cost for the campaign under review.",
          why: "Marketing quotes a discount percentage; the number that matters to us is promotion_cost against the margin the products can absorb.",
          urn: PROMOTIONS,
          url: entityUrl(PROMOTIONS),
          sql: "SELECT promotion_name, promotion_start_date, promotion_end_date, promotion_cost\nFROM order_entry_db.order_entry.promotions;",
        },
        {
          title: "Check the price floor on the affected products",
          instruction:
            "Open the products model and compare list_price against min_price for everything in the campaign's categories. min_price is the floor, and a discount below it needs sign-off.",
          why: "min_price is the contractual floor, not a suggestion. Ask Priya Sharma before agreeing to anything under it; she stewards this model and knows which supplier agreements bind us.",
          urn: DBT_PRODUCTS,
          url: entityUrl(DBT_PRODUCTS),
          sql: "SELECT product_id, product_name, list_price, min_price\nFROM order_entry_db.order_entry.products\nWHERE product_status = 'orderable';",
          tips: "Priya Sharma is the Data Steward on this model, and the sign-off for anything below min_price.",
        },
      ],
      recorded: [
        { url: entityUrl(PROMOTIONS), urn: PROMOTIONS, title: "PROMOTIONS", note: "Campaign window and cost." },
        { url: entityUrl(DBT_PRODUCTS), urn: DBT_PRODUCTS, title: "products (dbt)", note: "Price floor. Ask Priya." },
      ],
      datahub: { saved: false },
    },
  ];
}

/* ── record ───────────────────────────────────────────────────────────── */

async function record(): Promise<void> {
  const books = runbooks();
  for (const handoff of books) {
    // Same code path the app uses when somebody stops recording. Whatever live
    // DataHub returns right now becomes the decay baseline.
    handoff.snapshots = await snapshotHandoff(handoff.steps);
    saveHandoff(handoff);
    const urns = Object.keys(handoff.snapshots);
    console.log(`✓ ${handoff.id}: ${handoff.steps.length} steps, snapshotted ${urns.length} entities`);
    for (const urn of urns) {
      const s = handoff.snapshots[urn];
      console.log(
        `    ${s.exists ? "✓" : "✗"} ${s.name ?? urn}: ${s.fields.length} columns, ${s.owners.length} owner refs, ` +
          `deprecated=${s.deprecated}, failingAssertions=${s.failingAssertions}`
      );
    }
  }
}

/* ── break ────────────────────────────────────────────────────────────── */

interface Manifest {
  brokenAt: string;
  changes: {
    kind: string;
    urn: string;
    detail: string;
    /** Everything needed to put it back. */
    undo: Record<string, unknown>;
  }[];
}

const UPDATE_DEPRECATION = `
  mutation updateDeprecation($input: UpdateDeprecationInput!) { updateDeprecation(input: $input) }
`;

async function breakCatalog(): Promise<void> {
  const manifest: Manifest = { brokenAt: new Date().toISOString(), changes: [] };

  /* 1. Drop a column the weekly-revenue runbook's SQL actually selects. */
  const schema = await readAspect(ORDER_DETAILS, "schemaMetadata");
  if (!schema) throw new Error("could not read ORDER_DETAILS schemaMetadata");
  const fields = schema.fields as { fieldPath: string }[];
  const dropped = fields.find((f) => f.fieldPath === "cost_of_delivery");
  if (!dropped) {
    console.log("• cost_of_delivery already gone from ORDER_DETAILS, skipping");
  } else {
    await writeAspect(ORDER_DETAILS, "schemaMetadata", {
      ...schema,
      fields: fields.filter((f) => f.fieldPath !== "cost_of_delivery"),
    });
    manifest.changes.push({
      kind: "column-dropped",
      urn: ORDER_DETAILS,
      detail: "Removed column `cost_of_delivery` from ORDER_DETAILS, which the weekly revenue runbook sums.",
      undo: { aspect: "schemaMetadata", field: dropped },
    });
    console.log("✓ dropped column cost_of_delivery from ORDER_DETAILS");
  }

  /* 2. Deprecate a table a runbook routes people to, mid-runbook. */
  const dep = await datahubGraphQL(UPDATE_DEPRECATION, {
    input: {
      urn: ORDER_HISTORY,
      deprecated: true,
      note: "Retired at the FY close. Snapshot history now lives in the warehouse's time-travel retention; use ORDER_DETAILS with a point-in-time filter instead.",
    },
  });
  if (dep.errors?.length) throw new Error(`deprecate ORDER_HISTORY: ${dep.errors.map((e) => e.message).join("; ")}`);
  manifest.changes.push({
    kind: "deprecated",
    urn: ORDER_HISTORY,
    detail: "Deprecated ORDER_HISTORY, which step 1 of the backfill runbook tells you to query.",
    undo: { mutation: "updateDeprecation", deprecated: false },
  });
  console.log("✓ deprecated ORDER_HISTORY");

  /* 3. Move an owner a runbook tells you to page. */
  const removed = await callDataHubTool("remove_owners", {
    owner_urns: [PRIYA_SHARMA],
    entity_urns: [DBT_PRODUCTS],
  });
  if (removed.isError) {
    console.log(`• remove_owners reported: ${removed.content.slice(0, 200)}`);
  } else {
    manifest.changes.push({
      kind: "owner-removed",
      urn: DBT_PRODUCTS,
      detail: "Removed Priya Sharma as Data Steward on the products model, whom the margin runbook sends you to for sign-off.",
      undo: { mcp: "add_owners", ownerUrn: PRIYA_SHARMA, ownershipType: "__system__data_steward" },
    });
    console.log("✓ removed Priya Sharma from the products model");
  }

  mkdirSync(path.dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), MANIFEST)}. Run \`npm run showcase:drill restore\` to undo.`);
  console.log("Search indexing is eventually consistent; give it ~20s before `npm run validate`.");
}

/* ── restore ──────────────────────────────────────────────────────────── */

async function restore(): Promise<void> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  } catch {
    console.log("No break manifest found, so nothing to restore.");
    return;
  }

  for (const change of manifest.changes) {
    if (change.kind === "column-dropped") {
      const schema = await readAspect(change.urn, "schemaMetadata");
      if (!schema) continue;
      const fields = schema.fields as { fieldPath: string }[];
      const field = change.undo.field as { fieldPath: string };
      if (fields.some((f) => f.fieldPath === field.fieldPath)) continue;
      // Put it back where the pack had it, after wait_till_complete_yn.
      const at = fields.findIndex((f) => f.fieldPath === "delivery_type");
      const next = [...fields];
      next.splice(at >= 0 ? at : next.length, 0, field);
      await writeAspect(change.urn, "schemaMetadata", { ...schema, fields: next });
      console.log(`✓ restored column ${field.fieldPath} on ${change.urn}`);
    }
    if (change.kind === "deprecated") {
      await datahubGraphQL(UPDATE_DEPRECATION, { input: { urn: change.urn, deprecated: false, note: "" } });
      console.log(`✓ un-deprecated ${change.urn}`);
    }
    if (change.kind === "owner-removed") {
      const r = await callDataHubTool("add_owners", {
        owner_urns: [change.undo.ownerUrn],
        entity_urns: [change.urn],
        ownership_type: change.undo.ownershipType,
      });
      console.log(`${r.isError ? "•" : "✓"} restored owner on ${change.urn}${r.isError ? ` (${r.content.slice(0, 120)})` : ""}`);
    }
  }

  // Also undo what the sweep itself wrote, so the drill is repeatable from a
  // clean catalog: resolve the incidents it raised and drop the tags it applied.
  for (const urn of [...new Set(manifest.changes.map((c) => c.urn))]) {
    const open = await datahubGraphQL<{
      dataset: { incidents: { incidents: { urn: string; title: string }[] } } | null;
    }>(
      `query($urn: String!) {
         dataset(urn: $urn) { incidents(state: ACTIVE, start: 0, count: 50) { incidents { urn title } } }
       }`,
      { urn }
    );
    for (const inc of open.data?.dataset?.incidents?.incidents ?? []) {
      if (!/^stale runbook:/i.test(inc.title ?? "")) continue;
      const resolved = await datahubGraphQL(
        `mutation($urn: String!, $input: IncidentStatusInput!) { updateIncidentStatus(urn: $urn, input: $input) }`,
        { urn: inc.urn, input: { state: "RESOLVED", message: "Catalog restored by the instaboard showcase drill." } }
      );
      console.log(
        resolved.errors?.length
          ? `• could not resolve ${inc.urn}: ${resolved.errors.map((e) => e.message).join("; ").slice(0, 160)}`
          : `✓ resolved incident ${inc.urn}`
      );
    }

    const untag = await callDataHubTool("remove_tags", {
      tag_urns: [STALE_RUNBOOK_TAG_URN],
      entity_urns: [urn],
    });
    if (!untag.isError) console.log(`✓ removed Stale Runbook tag from ${urn}`);
  }

  writeFileSync(MANIFEST, JSON.stringify({ ...manifest, restoredAt: new Date().toISOString() }, null, 2));
}

/* ── receipts: the whole drill, captured ──────────────────────────────── */

/**
 * Run the full cycle and commit the evidence:
 *   record → sweep (clean) → break the catalog → sweep (drifted).
 *
 * Leaves the catalog broken on purpose so a judge can go and look at the
 * incidents and tags in the DataHub UI; `restore` puts it back.
 */
async function receipts(): Promise<void> {
  console.log("1/4  recording runbooks and snapshotting live DataHub…");
  await record();

  console.log("\n2/4  sweeping the clean catalog…");
  const before = await sweepRunbooks("showcase");
  console.log(`     ${before.checked} checked · ${before.drifted} with drift · ${before.broken} broken`);

  console.log("\n3/4  making real breaking changes…");
  await breakCatalog();

  // Search and the health summary are eventually consistent behind GMS.
  console.log("     waiting for DataHub to index the changes…");
  await new Promise((r) => setTimeout(r, 25_000));

  console.log("\n4/4  sweeping the changed catalog…");
  const after = await sweepRunbooks("showcase");
  console.log(`     ${after.checked} checked · ${after.drifted} with drift · ${after.broken} broken`);

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const out = {
    capturedAt: new Date().toISOString(),
    gms: GMS(),
    catalog: "showcase-ecommerce, the demo datapack DataHub publishes (1,065 entities)",
    method:
      "Runbooks recorded against the datapack and snapshotted through the same code path the app uses. " +
      "The catalog was then changed through DataHub's own write APIs: a column dropped from schemaMetadata, " +
      "a table deprecated via updateDeprecation, an owner removed via the MCP server's remove_owners. " +
      "The decay engine was told none of it; it re-read the catalog and worked out what had broken.",
    breakingChanges: manifest.changes.map((c) => ({ kind: c.kind, urn: c.urn, detail: c.detail })),
    before: {
      at: before.at,
      summary: `${before.checked} checked · ${before.drifted} with drift · ${before.broken} broken`,
      rows: before.rows.map((r) => ({ id: r.id, severity: r.severity, findings: r.findings })),
    },
    after: {
      at: after.at,
      summary: `${after.checked} checked · ${after.drifted} with drift · ${after.broken} broken`,
      exitCode: after.broken > 0 ? 2 : 0,
      rows: after.rows.map((r) => ({
        id: r.id,
        severity: r.severity,
        findings: r.findings,
        documentUrn: r.receipt?.documentUrn ?? null,
        incidents: r.native?.incidents ?? [],
        taggedDatasets: r.native?.tagged ?? [],
      })),
    },
  };

  const file = path.join(process.cwd(), "examples", "live", "showcase-decay-receipts.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
  console.log("The catalog is left changed so you can see the incidents and tags in DataHub.");
  console.log("Run `npm run showcase:drill restore` when you're done looking.");
}

/* ── clean ────────────────────────────────────────────────────────────── */

function clean(): void {
  for (const h of runbooks()) {
    console.log(`${deleteHandoff(h.id) ? "✓ removed" : "• not present"} ${h.id}`);
  }
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  const cmd = process.argv[2];
  if (isDemoMode()) {
    console.error("DEMO_MODE is set. The drill needs a real DataHub, so unset it.");
    process.exit(1);
  }
  switch (cmd) {
    case "record":
      return record();
    case "break":
      return breakCatalog();
    case "receipts":
      return receipts();
    case "restore":
      return restore();
    case "clean":
      return clean();
    default:
      console.error("usage: npm run showcase:drill <record|break|receipts|restore|clean>");
      process.exit(1);
  }
}

main()
  // The MCP stdio subprocess keeps the event loop alive, so exit explicitly.
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
