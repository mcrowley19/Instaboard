import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `npm run prove:sync` needs a live DataHub, so CI checks the committed
 * receipts instead: the full lifecycle of the body of record must be in
 * there, in order, with no failed check — save, sync, a catalog edit that
 * wins, a push blocked until the edit is folded in, a compare-and-set push,
 * and a conflict where the push is refused and the steward's words survive.
 */

interface Receipts {
  checks: { phase: string; what: string; passed: boolean; detail: string }[];
  summary: { total: number; passed: number; failed: number };
  syncs: { phase: string; status: string; action: string; detail: string }[];
  method: string;
}

const receipts = JSON.parse(
  readFileSync(path.join(process.cwd(), "examples", "live", "document-sync-receipts.json"), "utf8")
) as Receipts;

describe("the committed body-of-record proof", () => {
  it("passed every check it ran", () => {
    const failed = receipts.checks.filter((c) => !c.passed);
    expect(failed.map((c) => `${c.phase}: ${c.what} — ${c.detail}`)).toEqual([]);
    expect(receipts.summary.failed).toBe(0);
    expect(receipts.summary.total).toBeGreaterThanOrEqual(12);
  });

  it("walks the whole lifecycle in order", () => {
    const sequence = receipts.syncs.map((s) => `${s.status}:${s.action}`);
    expect(sequence).toEqual([
      "in-sync:none",
      "catalog-ahead:pulled",
      "in-sync:none",
      "local-ahead:refused",
      "local-ahead:none",
      "in-sync:pushed",
      "conflict:none",
      "conflict:refused",
    ]);
  });

  it("pulled the catalog edit rather than overwriting it", () => {
    const pulled = receipts.syncs.find((s) => s.action === "pulled");
    expect(pulled?.detail).toContain("the catalog wins");
  });

  it("blocked the push until the pulled edit was folded in", () => {
    const blocked = receipts.syncs.find((s) => s.phase === "blocked-push");
    expect(blocked?.action).toBe("refused");
    expect(blocked?.detail).toContain("folded");
  });

  it("refused the conflicting push and read the steward's edit back intact", () => {
    const refusal = receipts.syncs.find((s) => s.phase === "refused-push");
    expect(refusal?.action).toBe("refused");
    expect(refusal?.detail).toContain("Reconcile first");
    const intact = receipts.checks.find((c) => c.what.includes("still in the catalog"));
    expect(intact?.passed).toBe(true);
  });

  it("says how it was done, through DataHub's own mutation", () => {
    expect(receipts.method).toContain("updateDocumentContents");
    expect(receipts.method).toContain("compare-and-set");
  });
});
