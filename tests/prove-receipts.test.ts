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
    before: Validation | null;
    after:
      | (Validation & {
          documentUrn: string | null;
          assertions: { urn: string; result: string }[];
          incidents: { urn: string; assignees: string[] }[];
          tagged: string[];
          proposal: { edits: { kind: string }[]; reviewers: string[]; diff: string } | null;
        })
      | null;
    afterRestore:
      | (Validation & {
          retracted: { attempted: boolean; untagged: string[]; kept: { datasetUrn: string }[] } | null;
          resolvedIncidents: { urn: string; datasetUrn: string }[];
        })
      | null;
  };
  tagReadBack: {
    tagsWhileBroken: Record<string, string[]>;
    tagsAfterRestore: Record<string, string[]>;
  };
}

interface Validation {
  severity: string;
  verdict?: string;
  claims: { total: number; broken: number; unvalidatable?: number };
  coverage?: {
    stepsTotal: number;
    stepsValidated: number;
    claimsUnvalidatable: number;
    summary: string;
    steps: { stepIndex: number; state: string; gaps: string[]; detail: string }[];
  };
}

const STALE_TAG = "urn:li:tag:StaleRunbook";

function load(file: string): Receipts {
  return JSON.parse(readFileSync(path.join(process.cwd(), "examples", "live", file), "utf8")) as Receipts;
}

/**
 * The proof runs on two catalogs: the one this repo seeds, and DataHub's own
 * published datapack. Both sets of receipts are committed and both are checked,
 * because "it works on the catalog we built" is exactly the objection the second
 * run exists to answer.
 */
const RUNS: [string, Receipts][] = [
  ["northbeam", load("prove-loop-receipts.json")],
  ["showcase-ecommerce", load("prove-loop-receipts-showcase.json")],
];

describe.each(RUNS)("the committed end-to-end proof on %s", (_catalog, receipts) => {
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
    // The point of the incident is that it reaches a person — where there is one
    // to reach. On DataHub's own datapack, ORDER_HISTORY has no owners at all,
    // and leaving that incident unassigned is correct: guessing an assignee
    // would be worse than leaving it for triage.
    expect(after.incidents.some((i) => i.assignees.length > 0)).toBe(true);
  });

  it("proposed a correction for each mechanically fixable break", () => {
    const proposal = receipts.validations.after?.proposal;
    expect(proposal).toBeTruthy();
    expect(proposal!.edits.map((e) => e.kind).sort()).toEqual([
      "column-rename",
      "dataset-replacement",
      "owner-update",
    ]);
    // The renamed column differs per catalog; assert the diff carries whichever
    // one this run planted rather than hard-coding Northbeam's.
    const renamed = proposal!.edits.find((e) => e.kind === "column-rename");
    expect(renamed).toBeDefined();
    expect(proposal!.diff).toContain((renamed as { to?: string }).to ?? "");
    expect(proposal!.reviewers.length).toBeGreaterThan(0);
  });

  /*
   * The half a detector usually skips. A tool that only ever adds state leaves a
   * catalog full of warnings about problems fixed months ago, so the tag has to
   * come back off — and the receipt has to show DataHub agreeing, not just the
   * write returning success.
   */
  it("applied the stale tag and took it back off, with DataHub read back on both sides", () => {
    const tagged = receipts.validations.after!.tagged;
    expect(tagged.length).toBeGreaterThan(0);

    for (const urn of tagged) {
      expect(receipts.tagReadBack.tagsWhileBroken[urn], `no read-back for ${urn}`).toContain(STALE_TAG);
      expect(receipts.tagReadBack.tagsAfterRestore[urn]).not.toContain(STALE_TAG);
    }

    const retracted = receipts.validations.afterRestore?.retracted;
    expect(retracted?.attempted).toBe(true);
    expect(retracted!.untagged.length).toBeGreaterThan(0);
  });

  it("closed the incidents it opened once the runbook was repaired", () => {
    expect(receipts.validations.afterRestore?.resolvedIncidents.length).toBeGreaterThan(0);
  });

  /*
   * The distinction that stops a clean report from lying: "nothing drifted"
   * and "nothing could be checked" have to be separable, on every run.
   */
  it("reports coverage on every validation, not only the ones that found something", () => {
    for (const [name, validation] of [
      ["before", receipts.validations.before],
      ["after", receipts.validations.after],
      ["afterRestore", receipts.validations.afterRestore],
    ] as const) {
      expect(validation?.coverage, `${name} has no coverage`).toBeTruthy();
      expect(validation!.coverage!.summary).toMatch(/\d+\/\d+ steps validated/);
      expect(validation!.coverage!.stepsTotal).toBeGreaterThan(0);
    }
  });

  it("never calls a run with unchecked claims a pass", () => {
    for (const validation of [receipts.validations.before, receipts.validations.afterRestore]) {
      const gaps = validation!.coverage!.claimsUnvalidatable;
      expect(validation!.severity).toBe("ok");
      expect(validation!.verdict).toBe(gaps > 0 ? "INSUFFICIENT_DATA" : "PASS");
    }
  });

  it("names the catalog gap behind every unvalidatable step", () => {
    const gapped = receipts.validations.afterRestore!.coverage!.steps.filter((s) => s.gaps.length > 0);
    for (const step of gapped) {
      expect(step.state).not.toBe("validated");
      expect(step.detail.length).toBeGreaterThan(20);
      for (const gap of step.gaps) expect(["schema", "ownership", "health"]).toContain(gap);
    }
  });

  it("was captured in one run rather than assembled from several", () => {
    expect(Date.parse(receipts.finishedAt)).toBeGreaterThan(Date.parse(receipts.startedAt));
  });
});
