import { describe, expect, it } from "vitest";
import { DEMO_MUTATIONS, DEMO_URNS, demoRunbook, revalidateDemo } from "../lib/demo-drift";

/**
 * The interactive demo is only worth showing if it runs the real engine. These
 * pin the two things that would quietly make it theatre: a scripted verdict, and
 * state leaking between visitors.
 */

describe("the interactive demo", () => {
  it("validates the untouched catalog without inventing drift", () => {
    const { report } = revalidateDemo([]);
    expect(report.findings).toEqual([]);
    expect(report.severity).toBe("ok");
  });

  it("does not report a clean run as a pass when a step cannot be checked", () => {
    // mrr_monthly has no assertions in the fixture, so step 3's health claim is
    // unanswerable. This is the case the third verdict state exists for.
    const { report } = revalidateDemo([]);
    expect(report.verdict).toBe("INSUFFICIENT_DATA");
    expect(report.coverage?.claimsUnvalidatable).toBe(1);
    expect(report.coverage?.steps.find((s) => s.urn === DEMO_URNS.mrrMonthly)?.gaps).toEqual(["health"]);
  });

  it("catches the dropped column against the step whose SQL selects it", () => {
    const { report } = revalidateDemo(["drop-column"]);
    const finding = report.findings.find((f) => f.kind === "column-missing");
    expect(finding?.stepIndex).toBe(1);
    expect(finding?.detail).toContain("net_amount_usd");
    expect(report.verdict).toBe("FINDING");
    expect(report.severity).toBe("broken");
  });

  it("catches the deprecation and the owner who moved on", () => {
    const { report } = revalidateDemo(["deprecate", "remove-owner"]);
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain("newly-deprecated");
    expect(kinds).toContain("owner-changed");
    expect(report.findings.find((f) => f.kind === "owner-changed")?.detail).toContain("Mike Rodriguez");
  });

  it("leaves nothing behind between calls", () => {
    // The route is stateless so two visitors cannot see each other's catalog.
    revalidateDemo(DEMO_MUTATIONS.map((m) => m.id));
    expect(revalidateDemo([]).report.findings).toEqual([]);
  });

  it("ignores a mutation id it does not recognise rather than failing", () => {
    const { report, applied } = revalidateDemo(["drop-column", "not-a-real-mutation"]);
    expect(applied).toHaveLength(1);
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it("re-fingerprints after mutating, so the pins stay recomputable", () => {
    const { report } = revalidateDemo(["drop-column"]);
    const recorded = demoRunbook().snapshots![DEMO_URNS.fctRevenue].version!.aspects.schema;
    const now = report.versions![DEMO_URNS.fctRevenue].aspects.schema;
    expect(now).not.toBe(recorded);
    expect(now).toMatch(/^[0-9a-f]{12}$/);
  });

  it("offers a change for every step of the runbook", () => {
    // A demo that can only break one step proves less than it looks.
    const steps = new Set(DEMO_MUTATIONS.map((m) => m.affectsStep));
    expect([...steps].sort()).toEqual([1, 2, 3]);
  });
});
