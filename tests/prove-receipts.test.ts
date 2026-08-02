import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `npm run prove` needs Docker and a live DataHub, so CI cannot run it. What CI
 * can do is refuse to accept receipts that don't say what the README says they
 * say — the same trick `npm run eval:verify` plays on the benchmark scorecards.
 *
 * If the committed receipts are stale, partial, or carry a failed check, this
 * fails on push. Re-run `npm run prove` and commit what it actually produced.
 */

interface Receipts {
  startedAt: string;
  finishedAt: string;
  breakingChanges: { kind: string; urn: string; detail: string }[];
  checks: { phase: string; what: string; passed: boolean; detail: string }[];
  summary: { total: number; passed: number; failed: number };
  validations: {
    before: { severity: string; claims: { total: number; broken: number } } | null;
    after: {
      severity: string;
      claims: { total: number; broken: number };
      documentUrn: string | null;
      assertions: { urn: string; result: string }[];
      incidents: { urn: string; assignees: string[] }[];
      tagged: string[];
      proposal: { edits: { kind: string }[]; reviewers: string[]; diff: string } | null;
    } | null;
    afterRestore: { severity: string; claims: { total: number; broken: number } } | null;
  };
}

const receipts = JSON.parse(
  readFileSync(path.join(process.cwd(), "examples", "live", "prove-loop-receipts.json"), "utf8")
) as Receipts;

describe("the committed end-to-end proof", () => {
  it("passed every check it ran", () => {
    const failed = receipts.checks.filter((c) => !c.passed);
    expect(failed.map((c) => `${c.phase}: ${c.what} — ${c.detail}`)).toEqual([]);
    expect(receipts.summary.failed).toBe(0);
    expect(receipts.summary.passed).toBe(receipts.summary.total);
  });

  it("covers the whole loop, not a subset of it", () => {
    const phases = new Set(receipts.checks.map((c) => c.phase));
    for (const phase of ["datahub", "ingest", "capture", "validate", "break", "revalidate", "write-back", "propose", "restore"]) {
      expect(phases, `missing phase ${phase}`).toContain(phase);
    }
  });

  it("broke the catalog in the three ways runbooks actually rot", () => {
    expect(receipts.breakingChanges.map((c) => c.kind).sort()).toEqual([
      "column-renamed",
      "deprecated",
      "owner-removed",
    ]);
  });

  it("started clean, caught the drift, and went clean again", () => {
    expect(receipts.validations.before?.severity).toBe("ok");
    expect(receipts.validations.before?.claims.broken).toBe(0);
    expect(receipts.validations.after?.severity).toBe("broken");
    expect(receipts.validations.after?.claims.broken).toBeGreaterThan(0);
    // The claims that had nothing to do with the breakage kept holding.
    expect(receipts.validations.after!.claims.total - receipts.validations.after!.claims.broken).toBeGreaterThan(0);
    expect(receipts.validations.afterRestore?.severity).toBe("ok");
    expect(receipts.validations.afterRestore?.claims.broken).toBe(0);
  });

  it("wrote the drift back to DataHub at every level the README claims", () => {
    const after = receipts.validations.after!;
    expect(after.documentUrn).toMatch(/^urn:li:document/);
    expect(after.assertions.some((a) => a.result === "FAILURE")).toBe(true);
    expect(after.tagged.length).toBeGreaterThan(0);
    expect(after.incidents.length).toBeGreaterThan(0);
    // The point of the incident is that it reaches a person.
    expect(after.incidents.every((i) => i.assignees.length > 0)).toBe(true);
  });

  it("proposed a correction for each mechanically fixable break", () => {
    const proposal = receipts.validations.after?.proposal;
    expect(proposal).toBeTruthy();
    expect(proposal!.edits.map((e) => e.kind).sort()).toEqual([
      "column-rename",
      "dataset-replacement",
      "owner-update",
    ]);
    expect(proposal!.diff).toContain("net_revenue_usd");
    expect(proposal!.reviewers.length).toBeGreaterThan(0);
  });

  it("was captured in one run rather than assembled from several", () => {
    expect(Date.parse(receipts.finishedAt)).toBeGreaterThan(Date.parse(receipts.startedAt));
  });
});
