import { describe, expect, it } from "vitest";
import { columnsReferencedInSql, groundTruthColumns, planDrifts } from "../lib/drift-injection";
import type { EntitySnapshot, Handoff } from "../lib/types";

/**
 * The planner decides what "correct" means for the drift benchmark, so it is the
 * part most worth pinning: a bug here does not fail the benchmark, it quietly
 * makes the score meaningless.
 */

const URN_A = "urn:li:dataset:(urn:li:dataPlatform:snowflake,db.s.a,PROD)";
const URN_B = "urn:li:dataset:(urn:li:dataPlatform:snowflake,db.s.b,PROD)";

function snapshot(urn: string, over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    urn,
    name: urn.endsWith("a,PROD)") ? "a" : "b",
    exists: true,
    fields: ["id", "net_amount_usd", "revenue_date", "unused_col", "another_unused"],
    owners: ["Priya Patel"],
    ownerUrns: ["urn:li:corpuser:priya.patel"],
    deprecated: false,
    openIncidents: 0,
    failingAssertions: 0,
    capturedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function runbook(over: Partial<Handoff> = {}): Handoff {
  return {
    id: "rb",
    title: "Test runbook",
    author: "Priya Patel",
    summary: "",
    createdAt: "2026-07-01T00:00:00.000Z",
    recorded: [],
    steps: [
      {
        title: "Pull revenue",
        instruction: "Sum the revenue for the month.",
        why: "Finance needs it.",
        urn: URN_A,
        sql: "SELECT SUM(net_amount_usd) FROM db.s.a WHERE revenue_date > '2026-01-01';",
      },
    ],
    ...over,
  };
}

describe("columnsReferencedInSql", () => {
  it("returns the identifiers a query names, without the SQL keywords", () => {
    const found = columnsReferencedInSql("SELECT SUM(net_amount_usd) FROM db.s.a WHERE revenue_date > '2026-01-01'");
    expect(found).toContain("net_amount_usd");
    expect(found).toContain("revenue_date");
    expect(found).not.toContain("select");
    expect(found).not.toContain("from");
    expect(found).not.toContain("sum");
  });
});

describe("groundTruthColumns", () => {
  it("keeps only identifiers that are real columns on the dataset", () => {
    const columns = groundTruthColumns(
      { sql: "SELECT net_amount_usd, not_a_column FROM db.s.a" },
      snapshot(URN_A)
    );
    expect(columns).toEqual(["net_amount_usd"]);
  });

  it("is empty for a step with no SQL, rather than guessing from prose", () => {
    // Guessing from prose here would score recall against the same heuristic the
    // engine uses, which is the thing this file exists to avoid.
    expect(groundTruthColumns({}, snapshot(URN_A))).toEqual([]);
  });
});

describe("planDrifts", () => {
  const live = { [URN_A]: snapshot(URN_A) };

  it("plants only on columns the step's SQL actually selects", () => {
    const [_decoy, ...drifts] = planDrifts([runbook()], live, [], { sharpDecoys: 0, decoys: 0 });
    const planted = [_decoy, ...drifts].filter((p) => !p.decoy);
    for (const drift of planted) {
      if (drift.kind !== "column-dropped" && drift.kind !== "column-renamed") continue;
      expect(["net_amount_usd", "revenue_date"]).toContain(drift.subject);
    }
  });

  it("never plants two drifts on one dataset, which would make attribution ambiguous", () => {
    const plans = planDrifts([runbook(), runbook({ id: "rb2" })], live, [], { decoys: 0, sharpDecoys: 0 });
    const urns = plans.map((p) => p.urn);
    expect(new Set(urns).size).toBe(urns.length);
  });

  it("reserves a decoy on a dataset a runbook reads, using a column no step mentions", () => {
    const plans = planDrifts([runbook()], live, [], { sharpDecoys: 1, decoys: 1 });
    const decoy = plans.find((p) => p.decoy);

    expect(decoy).toBeDefined();
    expect(decoy!.urn).toBe(URN_A);
    expect(decoy!.expect).toBeNull();
    // Must not pick a column the runbook depends on, or the "must produce
    // nothing" expectation would be wrong and the score would be nonsense.
    expect(["unused_col", "another_unused", "id"]).toContain(decoy!.subject);
  });

  it("rotates kinds so one kind cannot monopolise the benchmark", () => {
    const many = [URN_A, URN_B].map((urn, i) =>
      runbook({
        id: `rb${i}`,
        steps: [
          {
            title: "s",
            instruction: "Ask Priya Patel about this.",
            why: "y",
            urn,
            sql: "SELECT net_amount_usd, revenue_date FROM t",
          },
        ],
      })
    );
    const plans = planDrifts(many, { [URN_A]: snapshot(URN_A), [URN_B]: snapshot(URN_B) }, [], {
      decoys: 0,
      sharpDecoys: 0,
    });
    const kinds = plans.filter((p) => !p.decoy).map((p) => p.kind);
    expect(new Set(kinds).size).toBeGreaterThan(1);
  });

  it("expects the right finding kind for each drift it plants", () => {
    const plans = planDrifts([runbook()], live, [], { decoys: 0, sharpDecoys: 0 });
    for (const plan of plans.filter((p) => !p.decoy)) {
      if (plan.kind === "column-dropped" || plan.kind === "column-renamed") expect(plan.expect).toBe("column-missing");
      if (plan.kind === "deprecated") expect(plan.expect).toBe("newly-deprecated");
      if (plan.kind === "owner-removed") expect(plan.expect).toBe("owner-changed");
    }
  });

  it("does not plant a deprecation on something already deprecated", () => {
    const already = { [URN_A]: snapshot(URN_A, { deprecated: true }) };
    const plans = planDrifts([runbook()], already, [], { decoys: 0, sharpDecoys: 0 });
    expect(plans.some((p) => p.kind === "deprecated")).toBe(false);
  });

  it("carries what it needs to undo every plant", () => {
    const plans = planDrifts([runbook()], live, [], { decoys: 1, sharpDecoys: 1 });
    for (const plan of plans) expect(Object.keys(plan.undo).length).toBeGreaterThan(0);
  });
});
