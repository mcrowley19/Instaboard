import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Handoff } from "@/lib/types";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "handoffs-"));
  process.env.HANDOFF_DIR = dir;
});

afterAll(() => {
  delete process.env.HANDOFF_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("handoff store", () => {
  it("seeds a sample handoff on first list", async () => {
    const { listHandoffs } = await import("@/lib/handoff-store");
    const handoffs = listHandoffs();
    expect(handoffs.length).toBeGreaterThan(0);
    const sample = handoffs.find((h) => h.sample);
    expect(sample).toBeDefined();
    expect(sample!.steps.length).toBeGreaterThan(0);
    expect(sample!.steps[0].urn).toContain("urn:li:dataset:");
  });

  it("saves, gets, lists, and deletes a handoff", async () => {
    const { saveHandoff, getHandoff, listHandoffs, deleteHandoff, newHandoffId } = await import(
      "@/lib/handoff-store"
    );
    const id = newHandoffId("Weekly churn review");
    expect(id).toMatch(/^weekly-churn-review-/);

    const handoff: Handoff = {
      id,
      title: "Weekly churn review",
      author: "Priya Patel",
      summary: "Review churn by plan every Monday.",
      steps: [
        {
          title: "Open fct_churn",
          instruction: "Check last month's churn_rate by plan.",
          why: "Catches plan-level regressions early.",
          urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_churn,PROD)",
          url: "http://localhost:9002/dataset/x",
        },
      ],
      recorded: [{ url: "http://localhost:9002/dataset/x", note: "start here" }],
      createdAt: new Date().toISOString(),
    };

    saveHandoff(handoff);
    expect(getHandoff(id)?.title).toBe("Weekly churn review");
    expect(listHandoffs().some((h) => h.id === id)).toBe(true);
    expect(deleteHandoff(id)).toBe(true);
    expect(getHandoff(id)).toBeNull();
  });

  it("renders a handoff to markdown for DataHub write-back", async () => {
    const { handoffToMarkdown, getHandoff, ensureSampleHandoff } = await import("@/lib/handoff-store");
    ensureSampleHandoff();
    const sample = getHandoff("sample-monthly-mrr-report")!;
    const md = handoffToMarkdown(sample);
    expect(md).toContain("# Handoff: Monthly MRR report for the board deck");
    expect(md).toContain("## Step 1:");
    expect(md).toContain("**Why:**");
    expect(md).toContain("urn:li:dataset:");
    expect(md).toContain("```sql");
  });
});
