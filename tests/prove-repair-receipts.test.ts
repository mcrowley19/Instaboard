import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `npm run prove:repair` needs Docker and a live DataHub, so CI cannot run it.
 * What CI can do is refuse to accept repair receipts that don't say what the
 * README says they say — same contract as tests/prove-receipts.test.ts.
 *
 * The claims under test are the drill's whole point: consumers ran green, the
 * catalog rename made the readers fail, the approved correction brought them
 * back, and the repaired queries returned byte-identical result hashes to
 * their baseline. If any of that is missing from the committed receipts, this
 * fails on push. Re-run `npm run prove:repair` and commit what it produced.
 */

interface QueryRun {
  file: string;
  sqlHash: string;
  ok: boolean;
  error?: string;
  resultHash?: string;
}

interface Phase {
  queries: QueryRun[];
  allGreen: boolean;
}

interface Receipts {
  catalogProfile: string;
  breakingChanges: { kind: string; urn: string; detail: string }[];
  checks: { phase: string; what: string; passed: boolean; detail: string }[];
  summary: { total: number; passed: number; failed: number };
  consumer: { green: Phase | null; red: Phase | null; repaired: Phase | null };
  proposal: { edits: { kind: string; from: string; to: string; confidence: string }[] } | null;
  approval: {
    planHash: string;
    approvedBy: string;
    applied: { kind: string; from: string; to: string; confidence: string }[];
    withheld: { confidence: string }[];
  } | null;
  repairs: { file: string; hashBefore: string; hashAfter: string; replacements: number; changed: boolean }[];
  diff: string;
  hashes: {
    plan: string | null;
    catalog: Record<"baseline" | "broken" | "restored", Record<string, { entity: string; aspects: Record<string, string> } | null>>;
    artifacts: {
      files: Record<string, { before: string; after: string }>;
      results: Record<string, { green?: string; red?: string | null; repaired?: string }>;
    };
  };
  writeback: {
    tagsWhileBroken: Record<string, string[]>;
    tagsAfterRepair: Record<string, string[]>;
    incidentsResolved: { urn: string }[];
    assertionAfterRepair: { urn: string; result: string }[];
  } | null;
}

const STALE_TAG = "urn:li:tag:StaleRunbook";

const live = (file: string) => path.join(process.cwd(), "examples", "live", file);
const load = (file: string): Receipts => JSON.parse(readFileSync(live(file), "utf8")) as Receipts;

/**
 * Northbeam receipts are required; the showcase run joins the matrix when its
 * receipts land. Requiring at least the seeded catalog keeps this suite from
 * silently passing on nothing.
 */
const RUNS: [string, Receipts][] = [
  ["northbeam", load("prove-repair-receipts.json")],
  ...(existsSync(live("prove-repair-receipts-showcase.json"))
    ? ([["showcase-ecommerce", load("prove-repair-receipts-showcase.json")]] as [string, Receipts][])
    : []),
];

describe.each(RUNS)("the committed executed-repair proof on %s", (_catalog, receipts) => {
  const affected = receipts.repairs.filter((r) => r.changed).map((r) => r.file);
  const controls = receipts.repairs.filter((r) => !r.changed).map((r) => r.file);
  const results = receipts.hashes.artifacts.results;

  it("passed every check it ran", () => {
    const failed = receipts.checks.filter((c) => !c.passed);
    expect(failed.map((c) => `${c.phase}: ${c.what} — ${c.detail}`)).toEqual([]);
    expect(receipts.summary.failed).toBe(0);
    expect(receipts.summary.passed).toBe(receipts.summary.total);
  });

  it("covers the whole drill, baseline through restore", () => {
    const phases = new Set(receipts.checks.map((c) => c.phase));
    for (const phase of ["datahub", "ingest", "baseline", "break", "red", "detect", "approve", "repair", "restore"]) {
      expect(phases, `missing phase ${phase}`).toContain(phase);
    }
  });

  it("went green, then red, then green", () => {
    expect(receipts.consumer.green?.allGreen).toBe(true);
    expect(receipts.consumer.red?.allGreen).toBe(false);
    expect(receipts.consumer.repaired?.allGreen).toBe(true);
  });

  it("repaired at least two consumers and left a control untouched", () => {
    expect(affected.length).toBeGreaterThanOrEqual(2);
    expect(controls.length).toBeGreaterThanOrEqual(1);
  });

  it("brought every repaired query back to a byte-identical result hash", () => {
    for (const file of affected) {
      expect(results[file]?.green, file).toMatch(/^[0-9a-f]{64}$/);
      expect(results[file]?.red, `${file} should have failed while broken`).toBeNull();
      expect(results[file]?.repaired, file).toBe(results[file]?.green);
    }
  });

  it("never changed the control's file or its output at any phase", () => {
    for (const file of controls) {
      expect(results[file]?.red, file).toBe(results[file]?.green);
      expect(results[file]?.repaired, file).toBe(results[file]?.green);
      const f = receipts.hashes.artifacts.files[file];
      expect(f?.before, file).toBe(f?.after);
    }
  });

  it("binds the applied edits to the approved plan hash, derivable edits only", () => {
    expect(receipts.approval).not.toBeNull();
    expect(receipts.hashes.plan).toBe(receipts.approval!.planHash);
    expect(receipts.approval!.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipts.approval!.applied.length).toBeGreaterThan(0);
    for (const edit of receipts.approval!.applied) {
      expect(edit.kind).toBe("column-rename");
    }
    const proposed = receipts.proposal!.edits.length;
    expect(receipts.approval!.applied.length + receipts.approval!.withheld.length).toBe(proposed);
  });

  it("changed exactly one catalog entity's schema, and put it back", () => {
    const { baseline, broken, restored } = receipts.hashes.catalog;
    const urns = Object.keys(baseline);
    expect(urns.length).toBeGreaterThanOrEqual(3);
    const moved = urns.filter((u) => broken[u]?.aspects.schema !== baseline[u]?.aspects.schema);
    expect(moved).toEqual([receipts.breakingChanges[0].urn]);
    for (const urn of urns) {
      expect(restored[urn]?.aspects.schema, urn).toBe(baseline[urn]?.aspects.schema);
    }
  });

  it("made its one breaking change through the catalog, a column rename", () => {
    expect(receipts.breakingChanges).toHaveLength(1);
    expect(receipts.breakingChanges[0].kind).toBe("column-renamed");
  });

  it("wrote back, and took it back off, read back from GMS", () => {
    const wb = receipts.writeback;
    expect(wb).not.toBeNull();
    const taggedUrns = Object.keys(wb!.tagsWhileBroken);
    expect(taggedUrns.length).toBeGreaterThan(0);
    for (const urn of taggedUrns) {
      expect(wb!.tagsWhileBroken[urn], urn).toContain(STALE_TAG);
      expect(wb!.tagsAfterRepair[urn], urn).not.toContain(STALE_TAG);
    }
    expect(wb!.incidentsResolved.length).toBeGreaterThan(0);
    expect(wb!.assertionAfterRepair.length).toBeGreaterThan(0);
    for (const a of wb!.assertionAfterRepair) expect(a.result).toBe("SUCCESS");
  });

  it("carries the repair as a reviewable diff naming the new column", () => {
    const to = receipts.approval!.applied[0].to;
    expect(receipts.diff).toContain(to);
    expect(receipts.diff).toContain("(before)");
    expect(receipts.diff).toContain("(repaired)");
  });

  it("pins which version of each SQL file ran at every phase", () => {
    const greenBy = Object.fromEntries((receipts.consumer.green?.queries ?? []).map((q) => [q.file, q]));
    const repairedBy = Object.fromEntries((receipts.consumer.repaired?.queries ?? []).map((q) => [q.file, q]));
    for (const file of affected) {
      expect(greenBy[file].sqlHash, file).toBe(receipts.hashes.artifacts.files[file].before);
      expect(repairedBy[file].sqlHash, file).toBe(receipts.hashes.artifacts.files[file].after);
      expect(greenBy[file].sqlHash).not.toBe(repairedBy[file].sqlHash);
    }
  });
});
