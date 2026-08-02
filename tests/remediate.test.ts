import { describe, expect, it } from "vitest";
import { proposalToMarkdown, proposeFix, renameCandidate, replacementFromNote, unifiedDiff } from "../lib/remediate";
import type { DecayReport, EntitySnapshot, Handoff } from "../lib/types";

const URN = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)";
const MRR = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.mrr_monthly,PROD)";

function snapshot(urn: string, over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    urn,
    name: "fct_revenue",
    exists: true,
    fields: ["net_amount_usd", "revenue_date"],
    owners: ["Mike Rodriguez"],
    deprecated: false,
    openIncidents: 0,
    failingAssertions: 0,
    capturedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function runbook(): Handoff {
  return {
    id: "close",
    title: "Monthly close",
    author: "Priya Patel",
    summary: "",
    createdAt: "2026-07-01T00:00:00.000Z",
    recorded: [],
    snapshots: { [URN]: snapshot(URN) },
    steps: [
      {
        title: "Pull net revenue",
        instruction: "Sum net_amount_usd from fct_revenue for the close month.",
        why: "Finance reconciles to settled cash.",
        urn: URN,
        sql: "SELECT SUM(net_amount_usd) FROM analytics.marts.fct_revenue;",
        tips: "If the total looks short, ping Mike Rodriguez — he owns the dbt job.",
      },
    ],
  };
}

function report(over: Partial<DecayReport> = {}): DecayReport {
  return {
    handoffId: "close",
    checkedAt: "2026-08-01T00:00:00.000Z",
    severity: "broken",
    stepsChecked: 1,
    entitiesChecked: 1,
    hadSnapshot: true,
    findings: [],
    ...over,
  };
}

describe("renameCandidate", () => {
  it("matches a renamed column against the one that appeared alongside it", () => {
    expect(renameCandidate("net_amount_usd", ["net_amount_usd", "revenue_date"], ["net_revenue_usd", "revenue_date"]))
      .toMatchObject({ field: "net_revenue_usd" });
  });

  it("refuses to guess when two new columns match about equally well", () => {
    expect(
      renameCandidate("net_amount_usd", ["net_amount_usd"], ["net_amount_gbp", "net_amount_eur"])
    ).toBeNull();
  });

  it("refuses to guess when nothing is close", () => {
    expect(renameCandidate("net_amount_usd", ["net_amount_usd"], ["customer_id", "shipped_at"])).toBeNull();
  });
});

describe("replacementFromNote", () => {
  it("reads a table name out of a deprecation note", () => {
    expect(replacementFromNote("Rebuilt at the FY close. Use analytics.marts.mrr_monthly_v2 instead.")).toBe(
      "analytics.marts.mrr_monthly_v2"
    );
  });

  it("prefers an explicit URN when the note carries one", () => {
    expect(replacementFromNote(`Superseded by ${MRR}`)).toBe(MRR);
  });

  it("returns nothing when the note names no replacement", () => {
    expect(replacementFromNote("Retired at the FY close.")).toBeNull();
    expect(replacementFromNote(undefined)).toBeNull();
  });
});

describe("proposeFix", () => {
  it("rewrites a renamed column through the prose and the SQL", () => {
    const proposal = proposeFix(
      runbook(),
      report({
        findings: [
          {
            stepIndex: 0,
            stepTitle: "Pull net revenue",
            urn: URN,
            severity: "broken",
            kind: "column-missing",
            detail: "Column `net_amount_usd` is referenced by this step but no longer exists on fct_revenue.",
            claimId: "column-exists:abc",
          },
        ],
      }),
      { [URN]: snapshot(URN, { fields: ["net_revenue_usd", "revenue_date"] }) }
    );

    expect(proposal.edits).toHaveLength(1);
    expect(proposal.edits[0]).toMatchObject({ kind: "column-rename", from: "net_amount_usd", to: "net_revenue_usd" });
    expect(proposal.updated.steps[0].sql).toContain("net_revenue_usd");
    expect(proposal.updated.steps[0].instruction).toContain("net_revenue_usd");
    expect(proposal.diff).toContain("+SELECT SUM(net_revenue_usd)");
  });

  it("sends a dropped column with no plausible successor to a human instead of guessing", () => {
    const proposal = proposeFix(
      runbook(),
      report({
        findings: [
          {
            stepIndex: 0,
            stepTitle: "Pull net revenue",
            urn: URN,
            severity: "broken",
            kind: "column-missing",
            detail: "Column `net_amount_usd` is referenced by this step but no longer exists on fct_revenue.",
          },
        ],
      }),
      { [URN]: snapshot(URN, { fields: ["customer_id"] }) }
    );

    expect(proposal.edits).toHaveLength(0);
    expect(proposal.unresolved[0].needsHuman).toContain("close enough match");
  });

  it("repoints a departed owner, and the pronoun that referred to them", () => {
    const proposal = proposeFix(
      runbook(),
      report({
        findings: [
          {
            stepIndex: 0,
            stepTitle: "Pull net revenue",
            urn: URN,
            severity: "warning",
            kind: "owner-changed",
            detail: "This step says to contact Mike Rodriguez, who no longer owns fct_revenue.",
          },
        ],
      }),
      { [URN]: snapshot(URN, { owners: ["Priya Patel", "priya.patel@northbeam.io"] }) }
    );

    const tips = proposal.updated.steps[0].tips ?? "";
    expect(tips).toContain("ping Priya Patel");
    // Leaving "he" would make the step say something untrue about a real person.
    expect(tips).not.toMatch(/\bhe\b/i);
    expect(tips).toContain("Priya owns the dbt job");
    expect(proposal.edits[0].confidence).toBe("medium");
    expect(proposal.edits[0].rationale).toContain("Pronouns");
  });

  it("says so rather than inventing a contact when nobody owns the dataset now", () => {
    const proposal = proposeFix(
      runbook(),
      report({
        findings: [
          {
            stepIndex: 0,
            stepTitle: "Pull net revenue",
            urn: URN,
            severity: "warning",
            kind: "owner-changed",
            detail: "This step says to contact Mike Rodriguez, who no longer owns fct_revenue.",
          },
        ],
      }),
      { [URN]: snapshot(URN, { owners: [] }) }
    );

    expect(proposal.edits).toHaveLength(0);
    expect(proposal.unresolved[0].needsHuman).toContain("Nobody owns this dataset");
  });

  it("swallows the schema prefix when repointing a deprecated table", () => {
    const withMrr: Handoff = {
      ...runbook(),
      steps: [
        {
          title: "Reconcile",
          instruction: "Compare against mrr_monthly for the month.",
          why: "The board deck quotes MRR.",
          urn: MRR,
          sql: "SELECT month, mrr_usd FROM analytics.marts.mrr_monthly;",
        },
      ],
      snapshots: { [MRR]: snapshot(MRR, { name: "mrr_monthly" }) },
    };

    const proposal = proposeFix(
      withMrr,
      report({
        findings: [
          {
            stepIndex: 0,
            stepTitle: "Reconcile",
            urn: MRR,
            severity: "broken",
            kind: "newly-deprecated",
            detail: "mrr_monthly has been deprecated since this runbook was written.",
          },
        ],
      }),
      {
        [MRR]: snapshot(MRR, {
          name: "mrr_monthly",
          deprecated: true,
          deprecationNote: "Rebuilt at the FY close. Use analytics.marts.mrr_monthly_v2 instead.",
        }),
      }
    );

    const sql = proposal.updated.steps[0].sql ?? "";
    expect(sql).toContain("FROM analytics.marts.mrr_monthly_v2");
    expect(sql).not.toContain("analytics.marts.analytics.marts");
    // The note named a table, not a URN, so the step's entity link is still wrong.
    expect(proposal.unresolved[0].needsHuman).toContain("still points at the deprecated dataset");
  });

  it("does not rewrite the runbook over a health problem", () => {
    const proposal = proposeFix(
      runbook(),
      report({
        severity: "warning",
        findings: [
          {
            stepIndex: 0,
            stepTitle: "Pull net revenue",
            urn: URN,
            severity: "warning",
            kind: "failing-assertion",
            detail: "fct_revenue has 1 failing assertion.",
          },
        ],
      }),
      { [URN]: snapshot(URN, { failingAssertions: 1 }) }
    );

    expect(proposal.edits).toHaveLength(0);
    expect(proposal.diff).toBe("");
    expect(proposal.unresolved[0].needsHuman).toContain("current health problem");
  });

  it("names the people who own the data today as the reviewers", () => {
    const proposal = proposeFix(
      runbook(),
      report({
        findings: [
          {
            stepIndex: 0,
            stepTitle: "Pull net revenue",
            urn: URN,
            severity: "broken",
            kind: "column-missing",
            detail: "Column `net_amount_usd` is referenced by this step but no longer exists on fct_revenue.",
          },
        ],
      }),
      { [URN]: snapshot(URN, { fields: ["net_revenue_usd"], owners: ["Sarah Chen", "urn:li:corpuser:sarah.chen"] }) }
    );

    expect(proposal.reviewers).toEqual(["Sarah Chen"]);
    expect(proposalToMarkdown(proposal)).toContain("**Reviewers:** Sarah Chen");
  });
});

describe("unifiedDiff", () => {
  it("returns nothing when there is nothing to change", () => {
    expect(unifiedDiff("a", "b", "same\ntext", "same\ntext")).toBe("");
  });

  it("marks the changed line and keeps context either side", () => {
    const diff = unifiedDiff("a/x.md", "b/x.md", "one\ntwo\nthree\nfour", "one\ntwo\nTHREE\nfour");
    expect(diff).toContain("--- a/x.md");
    expect(diff).toContain("-three");
    expect(diff).toContain("+THREE");
    expect(diff).toContain(" four");
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it("handles pure additions and pure deletions", () => {
    expect(unifiedDiff("a", "b", "one", "one\ntwo")).toContain("+two");
    expect(unifiedDiff("a", "b", "one\ntwo", "one")).toContain("-two");
  });
});
