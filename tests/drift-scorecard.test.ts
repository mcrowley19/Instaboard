import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { driftTable, extractTable, scorecard, type BenchmarkResult } from "../lib/drift-scorecard";

/**
 * The published drift numbers, re-derived from the run they came from.
 *
 * This is the mechanism that makes the benchmark evidence rather than a claim: if
 * someone edits the table in the README, or re-runs the benchmark and forgets to
 * update it, the build fails. A score nobody can fail is a score to discount.
 */

const root = path.join(__dirname, "..");
const committed = JSON.parse(
  readFileSync(path.join(root, "examples/live/drift-benchmark.json"), "utf8")
) as BenchmarkResult;

describe("the published drift table", () => {
  it("matches the committed benchmark run, byte for byte", () => {
    const inReadme = extractTable(readFileSync(path.join(root, "README.md"), "utf8"));
    expect(inReadme, "README.md is missing the drift-table markers").not.toBeNull();
    expect(inReadme).toBe(driftTable(committed));
  });

  it("matches the generated scorecard", () => {
    const onDisk = readFileSync(path.join(root, "evals/results/drift-scorecard.md"), "utf8");
    expect(onDisk.trim()).toBe(scorecard(committed).trim());
  });
});

describe("the committed run itself", () => {
  it("planted negatives of both classes, or precision means nothing", () => {
    expect(committed.negatives.decoysPlanted).toBeGreaterThan(0);
    expect(committed.negatives.controlsPlanted).toBeGreaterThan(0);
  });

  it("planted at least one case the correction rule cannot solve", () => {
    // Without this, the correction score is assembled entirely from cases the
    // rule was designed for, and says nothing about where it gives out.
    expect(committed.planted.some((p) => p.hardCase)).toBe(true);
  });

  it("gives every miss a structural reason rather than a bare count", () => {
    for (const miss of committed.falseNegatives) expect(miss.reason.length).toBeGreaterThan(20);
    for (const miss of committed.corrections.misses) expect(miss.reason.length).toBeGreaterThan(20);
  });

  it("put the catalog back", () => {
    const [restored, total] = (committed.restored ?? "0/0").split("/").map(Number);
    expect(restored).toBe(total);
    expect(total).toBeGreaterThan(0);
  });
});

describe("driftTable", () => {
  it("reports a miss in the table rather than only in the prose below it", () => {
    const withMiss: BenchmarkResult = {
      ...committed,
      corrections: {
        eligible: 3,
        proposed: 2,
        misses: [{ id: "x", from: "a", to: "b", reason: "shares no tokens with the original name" }],
      },
    };
    expect(driftTable(withMiss)).toContain("**2/3**");
    expect(driftTable(withMiss)).toContain("1 named below");
  });
});
