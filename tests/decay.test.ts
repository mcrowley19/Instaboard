import { beforeAll, describe, expect, it } from "vitest";
import { sfUrn } from "../lib/demo-catalog";
import { detectDecay, decayToMarkdown, snapshotEntity, writeBackDecay } from "../lib/decay";
import type { EntitySnapshot, Handoff, HandoffStep } from "../lib/types";

// Decay detection reads the catalog through the MCP layer; point it at the fixture.
beforeAll(() => {
  process.env.DEMO_MODE = "true";
});

const PAYMENT_HEALTH = sfUrn("payment_health_daily");
const FCT_REVENUE = sfUrn("fct_revenue");

function snapshot(urn: string, over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    urn,
    exists: true,
    fields: [],
    owners: [],
    deprecated: false,
    openIncidents: 0,
    failingAssertions: 0,
    capturedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function handoff(steps: HandoffStep[], snapshots?: Record<string, EntitySnapshot>): Handoff {
  return {
    id: "test-handoff",
    title: "Test runbook",
    author: "Priya Patel",
    summary: "",
    steps,
    recorded: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    ...(snapshots ? { snapshots } : {}),
  };
}

describe("snapshotEntity", () => {
  it("captures schema, owners, and health from the catalog", async () => {
    const snap = await snapshotEntity(FCT_REVENUE);
    expect(snap.exists).toBe(true);
    expect(snap.fields).toContain("net_amount_usd");
    expect(snap.owners.join(" ")).toContain("Priya Patel");
    expect(snap.deprecated).toBe(false);
  });

  it("reads a failing assertion off the health tool", async () => {
    const snap = await snapshotEntity(PAYMENT_HEALTH);
    expect(snap.failingAssertions).toBe(1);
  });

  it("marks an unknown entity as missing rather than throwing", async () => {
    const snap = await snapshotEntity("urn:li:dataset:(urn:li:dataPlatform:snowflake,does.not.exist,PROD)");
    expect(snap.exists).toBe(false);
  });
});

describe("detectDecay", () => {
  it("flags an assertion that started failing after the runbook was written", async () => {
    const report = await detectDecay(
      handoff(
        [{ title: "Check payment health", instruction: "Open payment_health_daily.", why: "Catch outages.", urn: PAYMENT_HEALTH }],
        { [PAYMENT_HEALTH]: snapshot(PAYMENT_HEALTH, { fields: ["date", "success_rate"] }) }
      )
    );
    expect(report.severity).toBe("warning");
    expect(report.findings.map((f) => f.kind)).toContain("failing-assertion");
    expect(report.hadSnapshot).toBe(true);
  });

  it("reports a referenced column that has since disappeared", async () => {
    const report = await detectDecay(
      handoff(
        [
          {
            title: "Pull net revenue",
            instruction: "Sum net_amount_usd for the period.",
            why: "Gross includes refunds.",
            urn: FCT_REVENUE,
            sql: "SELECT SUM(net_amount_usd), SUM(legacy_amount_usd) FROM analytics.marts.fct_revenue;",
          },
        ],
        // legacy_amount_usd existed when recorded; it is not in the catalog now.
        { [FCT_REVENUE]: snapshot(FCT_REVENUE, { fields: ["net_amount_usd", "legacy_amount_usd"] }) }
      )
    );
    const columnFindings = report.findings.filter((f) => f.kind === "column-missing");
    expect(columnFindings).toHaveLength(1);
    expect(columnFindings[0].detail).toContain("legacy_amount_usd");
    expect(report.severity).toBe("broken");
  });

  it("does not flag a removed column the step never referenced", async () => {
    const report = await detectDecay(
      handoff(
        [{ title: "Pull revenue", instruction: "Use net_amount_usd.", why: "Canonical.", urn: FCT_REVENUE }],
        { [FCT_REVENUE]: snapshot(FCT_REVENUE, { fields: ["net_amount_usd", "some_unused_dropped_column"] }) }
      )
    );
    expect(report.findings.filter((f) => f.kind === "column-missing")).toHaveLength(0);
  });

  it("flags an owner the step tells you to contact who no longer owns the table", async () => {
    const report = await detectDecay(
      handoff(
        [
          {
            title: "Verify the load",
            instruction: "Check the row counts.",
            why: "Partial loads break the report.",
            urn: FCT_REVENUE,
            tips: "If it looks short, ping Dana Whitfield — she owns the dbt job.",
          },
        ],
        {
          [FCT_REVENUE]: snapshot(FCT_REVENUE, {
            fields: ["net_amount_usd"],
            owners: ["Dana Whitfield (Analytics Engineer, urn:li:corpuser:dana.whitfield)"],
          }),
        }
      )
    );
    const ownerFindings = report.findings.filter((f) => f.kind === "owner-changed");
    expect(ownerFindings).toHaveLength(1);
    expect(ownerFindings[0].detail).toContain("Dana Whitfield");
    expect(ownerFindings[0].remedy).toContain("Priya Patel");
  });

  it("stays quiet when nothing has drifted", async () => {
    const live = await snapshotEntity(FCT_REVENUE);
    const report = await detectDecay(
      handoff(
        [{ title: "Pull revenue", instruction: "Use net_amount_usd.", why: "Canonical.", urn: FCT_REVENUE }],
        { [FCT_REVENUE]: live }
      )
    );
    expect(report.severity).toBe("ok");
    expect(report.findings).toHaveLength(0);
  });

  it("still runs current-state checks with no baseline snapshot", async () => {
    const report = await detectDecay(
      handoff([{ title: "Use raw events", instruction: "Query events.", why: "Engagement.", urn: sfUrn("events_sessionized") }])
    );
    expect(report.hadSnapshot).toBe(false);
    expect(report.severity).toBe("ok");
  });

  it("marks a step whose entity has vanished as broken", async () => {
    const gone = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.deleted_table,PROD)";
    const report = await detectDecay(
      handoff([{ title: "Old step", instruction: "Query it.", why: "Legacy.", urn: gone }], {
        [gone]: snapshot(gone, { fields: ["id"] }),
      })
    );
    expect(report.severity).toBe("broken");
    expect(report.findings[0].kind).toBe("entity-missing");
  });
});

describe("writeBackDecay", () => {
  it("returns a receipt carrying the document URN the catalog reports", async () => {
    const h = handoff(
      [{ title: "Check payment health", instruction: "Open it.", why: "Catch outages.", urn: PAYMENT_HEALTH }],
      { [PAYMENT_HEALTH]: snapshot(PAYMENT_HEALTH, { fields: ["date"] }) }
    );
    const receipt = await writeBackDecay(h, await detectDecay(h));
    expect(receipt.written).toBe(true);
    expect(receipt.documentUrn).toMatch(/^urn:li:document/);
    expect(receipt.relatedAssets).toContain(PAYMENT_HEALTH);
  });
});

describe("decayToMarkdown", () => {
  it("writes a catalog-ready note naming the affected step", async () => {
    const h = handoff(
      [{ title: "Check payment health", instruction: "Open it.", why: "Catch outages.", urn: PAYMENT_HEALTH }],
      { [PAYMENT_HEALTH]: snapshot(PAYMENT_HEALTH, { fields: ["date"] }) }
    );
    const md = decayToMarkdown(h, await detectDecay(h));
    expect(md).toContain("Runbook validation: Test runbook");
    expect(md).toContain("Step 1: Check payment health");
    expect(md).toContain("failing-assertion");
  });
});
