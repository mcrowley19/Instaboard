import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyEditsToWorkspace,
  buildWarehouse,
  prepareWorkspace,
  rowCountFor,
  runWorkspace,
  valueFor,
} from "@/lib/consumer-workspace";
import type { ProposedEdit } from "@/lib/remediate";
import type { EntitySnapshot } from "@/lib/types";

const sf = (table: string) =>
  `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.${table},PROD)`;

function snap(table: string, fields: string[]): EntitySnapshot {
  return {
    urn: sf(table),
    name: table,
    exists: true,
    fields,
    owners: [],
    deprecated: false,
    openIncidents: 0,
    failingAssertions: 0,
    capturedAt: new Date().toISOString(),
  };
}

const FCT_REVENUE = ["revenue_id", "customer_id", "order_id", "gross_amount_usd", "net_amount_usd", "is_recurring", "revenue_date"];
const PAYMENT_HEALTH = ["date", "provider", "attempts", "success_rate"];
const MRR_MONTHLY = ["month", "plan", "mrr_usd", "arr_usd", "net_new_mrr_usd"];

const baseline = () => [
  snap("payment_health_daily", PAYMENT_HEALTH),
  snap("fct_revenue", FCT_REVENUE),
  snap("mrr_monthly", MRR_MONTHLY),
];

/** The drill's break, as the warehouse experiences it: one ALTER TABLE rename. */
const RENAME = { table: "fct_revenue", from: "net_amount_usd", to: "net_revenue_usd" };

const renameEdit: ProposedEdit = {
  stepIndex: 1,
  stepTitle: "Pull net revenue for the month",
  kind: "column-rename",
  from: "net_amount_usd",
  to: "net_revenue_usd",
  rationale: "test",
  confidence: "high",
  occurrences: 1,
};

describe("deterministic warehouse values", () => {
  it("returns the same value for the same key, whatever ran before", () => {
    const a = valueFor("fct_revenue", 7, 4, "net_amount_usd");
    valueFor("other_table", 0, 0, "noise");
    const b = valueFor("fct_revenue", 7, 4, "net_amount_usd");
    expect(a).toBe(b);
  });

  it("gives the same value for the same position whichever build asks", () => {
    expect(valueFor("fct_revenue", 3, 4, "net_amount_usd")).toBe(valueFor("fct_revenue", 3, 4, "net_amount_usd"));
  });

  it("varies values across rows and tables", () => {
    const values = new Set(Array.from({ length: 20 }, (_, r) => valueFor("fct_revenue", r, 4, "net_amount_usd")));
    expect(values.size).toBeGreaterThan(10);
    expect(valueFor("fct_revenue", 0, 4, "net_amount_usd")).not.toBe(valueFor("mrr_monthly", 0, 4, "net_amount_usd"));
  });
});

describe("buildWarehouse", () => {
  it("creates one table per snapshot with the catalog's columns and a stable row count", () => {
    const { db, tables } = buildWarehouse(baseline());
    expect(tables.map((t) => t.table).sort()).toEqual(["fct_revenue", "mrr_monthly", "payment_health_daily"]);
    const fct = tables.find((t) => t.table === "fct_revenue")!;
    expect(fct.columns).toEqual(FCT_REVENUE);
    expect(fct.rows).toBe(rowCountFor("fct_revenue"));
    const count = db.prepare("SELECT COUNT(*) AS n FROM fct_revenue").all() as { n: number }[];
    expect(count[0].n).toBe(fct.rows);
    db.close();
  });

  it("skips snapshots without a schema rather than creating empty tables", () => {
    const { db, tables } = buildWarehouse([snap("fct_revenue", FCT_REVENUE), snap("ghost", [])]);
    expect(tables.map((t) => t.table)).toEqual(["fct_revenue"]);
    db.close();
  });
});

describe("the consumer workspace, green to red to green", () => {
  const source = path.join(process.cwd(), "examples", "consumer", "northbeam");
  const work = mkdtempSync(path.join(os.tmpdir(), "instaboard-consumer-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const files = prepareWorkspace(source, work);

  it("copies every committed consumer query into the workspace", () => {
    expect(files).toContain("monthly_net_revenue.sql");
    expect(files).toContain("payment_health_window.sql");
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  const green = runWorkspace(work, baseline());

  it("runs every query green against the baseline schema, with a result hash", () => {
    expect(green.allGreen).toBe(true);
    for (const q of green.queries) {
      expect(q.resultHash).toMatch(/^[0-9a-f]{64}$/);
      expect(q.rowCount).toBeGreaterThan(0);
    }
  });

  const red = runWorkspace(work, baseline(), [RENAME]);
  const redBy = Object.fromEntries(red.queries.map((q) => [q.file, q]));
  const greenBy = Object.fromEntries(green.queries.map((q) => [q.file, q]));

  it("fails exactly the readers of the renamed column, naming the column", () => {
    expect(redBy["monthly_net_revenue.sql"].ok).toBe(false);
    expect(redBy["monthly_net_revenue.sql"].error).toContain("net_amount_usd");
    expect(redBy["refund_drag.sql"].ok).toBe(false);
  });

  it("keeps the control green through the break, with an identical hash", () => {
    expect(redBy["payment_health_window.sql"].ok).toBe(true);
    expect(redBy["payment_health_window.sql"].resultHash).toBe(greenBy["payment_health_window.sql"].resultHash);
  });

  it("renames through ALTER TABLE, so data cannot move even when the new name sorts elsewhere", () => {
    // In a rebuild from a name-sorted post-rename schema, pushing
    // gross_amount_usd to the far end of the alphabet would shift every
    // fct_revenue column that sorts after it, net_amount_usd included, and
    // quietly change what monthly_net_revenue.sql sums. That is how the
    // showcase datapack broke the first live run of this drill. The ALTER
    // moves the name and nothing else.
    const renamed = runWorkspace(work, baseline(), [
      { table: "fct_revenue", from: "gross_amount_usd", to: "zz_gross_amount_usd" },
    ]);
    const by = Object.fromEntries(renamed.queries.map((q) => [q.file, q]));
    expect(by["refund_drag.sql"].ok).toBe(false);
    expect(by["monthly_net_revenue.sql"].resultHash).toBe(greenBy["monthly_net_revenue.sql"].resultHash);
    expect(by["payment_health_window.sql"].resultHash).toBe(greenBy["payment_health_window.sql"].resultHash);
    expect(renamed.tables.find((t) => t.table === "fct_revenue")!.columns).toContain("zz_gross_amount_usd");
  });

  it("applies the approved rename to the affected files only", () => {
    const repairs = applyEditsToWorkspace(work, [renameEdit]);
    const by = Object.fromEntries(repairs.map((r) => [r.file, r]));
    expect(by["monthly_net_revenue.sql"].changed).toBe(true);
    expect(by["monthly_net_revenue.sql"].replacements).toBeGreaterThan(0);
    expect(by["payment_health_window.sql"].changed).toBe(false);
    expect(by["payment_health_window.sql"].hashBefore).toBe(by["payment_health_window.sql"].hashAfter);
    expect(readFileSync(path.join(work, "monthly_net_revenue.sql"), "utf8")).toContain("net_revenue_usd");
    expect(readFileSync(path.join(work, "monthly_net_revenue.sql"), "utf8")).not.toContain("net_amount_usd");
  });

  it("goes green again with byte-identical result hashes, the repair's central claim", () => {
    const repaired = runWorkspace(work, baseline(), [RENAME]);
    expect(repaired.allGreen).toBe(true);
    const by = Object.fromEntries(repaired.queries.map((q) => [q.file, q]));
    for (const file of files) {
      expect(by[file].resultHash, file).toBe(greenBy[file].resultHash);
    }
  });

  it("only substitutes whole words, so an identifier containing the old name survives", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "instaboard-word-"));
    try {
      writeFileSync(
        path.join(dir, "superset.sql"),
        "SELECT net_amount_usd, net_amount_usd_total FROM fct_revenue;\n"
      );
      const repairs = applyEditsToWorkspace(dir, [renameEdit]);
      expect(repairs[0].replacements).toBe(1);
      const after = readFileSync(path.join(dir, "superset.sql"), "utf8");
      expect(after).toContain("net_revenue_usd,");
      expect(after).toContain("net_amount_usd_total");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
