import { describe, expect, it } from "vitest";
import { diffAgainstCatalog, measurementProfile } from "@/lib/decay";
import type { EntitySnapshot, Handoff } from "@/lib/types";

const URN = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)";

function snap(description: string | undefined): EntitySnapshot {
  return {
    urn: URN,
    name: "fct_revenue",
    exists: true,
    fields: ["net_amount_usd", "revenue_date", "customer_id"],
    ...(description !== undefined
      ? { fieldMeta: { net_amount_usd: { description }, revenue_date: { description: "Settlement date." } } }
      : {}),
    owners: [],
    deprecated: false,
    openIncidents: 0,
    failingAssertions: 0,
    capturedAt: "2026-07-01T00:00:00.000Z",
  };
}

function handoff(recorded: EntitySnapshot): Handoff {
  return {
    id: "semantic-test",
    title: "Semantic drift test",
    author: "Test",
    summary: "test",
    createdAt: "2026-07-01T00:00:00.000Z",
    recorded: [],
    steps: [
      {
        title: "Pull net revenue",
        instruction: "Sum the month's net revenue.",
        why: "Finance quotes it.",
        urn: URN,
        sql: "SELECT SUM(net_amount_usd) AS net_revenue FROM fct_revenue GROUP BY 1;",
      },
    ],
    snapshots: { [URN]: recorded },
  };
}

describe("measurementProfile", () => {
  it("returns null when there is nothing to profile", () => {
    expect(measurementProfile(undefined)).toBeNull();
    expect(measurementProfile("   ")).toBeNull();
  });

  it("returns an empty profile for a description with no measurement terms", () => {
    expect(measurementProfile("Login email.")).toBe("");
  });

  it("moves when units, inclusion words or numbers move", () => {
    const before = measurementProfile("Charged amount minus refunds — use this for revenue.");
    expect(measurementProfile("Charged amount minus refunds, in cents — use this for revenue.")).not.toBe(before);
    expect(measurementProfile("Charged amount before refunds.")).toBe(measurementProfile("Charged amount before refunds."));
  });

  it("stays put under a rewording that keeps the same measurement terms", () => {
    const a = measurementProfile("Charged amount minus refunds — use this for revenue.");
    const b = measurementProfile("The amount charged, with refunds taken out. This is the revenue column to use.");
    expect(a).toBe(b);
  });
});

describe("the semantic-drift finding", () => {
  const recordedDesc = "Charged amount minus refunds — use this for revenue.";

  it("fires when a referenced column's documented meaning moves", () => {
    const live = snap("Charged amount minus refunds, in cents — use this for revenue.");
    const report = diffAgainstCatalog(handoff(snap(recordedDesc)), { [URN]: live });
    const finding = report.findings.find((f) => f.kind === "semantic-drift");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.detail).toContain("net_amount_usd");
    expect(finding!.detail).toContain("in cents");
  });

  it("stays silent under a rewording with the same measurement terms", () => {
    const live = snap("The amount charged, with refunds taken out. This is the revenue column to use.");
    const report = diffAgainstCatalog(handoff(snap(recordedDesc)), { [URN]: live });
    expect(report.findings.filter((f) => f.kind === "semantic-drift")).toHaveLength(0);
  });

  it("stays silent when the changed column is one the step never reads", () => {
    const recorded = snap(recordedDesc);
    recorded.fieldMeta!.customer_id = { description: "FK to customers." };
    const live = snap(recordedDesc);
    live.fieldMeta!.customer_id = { description: "FK to customers, sampled weekly." };
    const report = diffAgainstCatalog(handoff(recorded), { [URN]: live });
    expect(report.findings.filter((f) => f.kind === "semantic-drift")).toHaveLength(0);
  });

  it("treats a missing description as a gap, never a finding", () => {
    const report = diffAgainstCatalog(handoff(snap(undefined)), { [URN]: snap("Now in cents.") });
    expect(report.findings.filter((f) => f.kind === "semantic-drift")).toHaveLength(0);
  });
});
