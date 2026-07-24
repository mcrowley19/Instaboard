import { describe, expect, it } from "vitest";
import { callDemoTool } from "../lib/demo-mcp";
import { walkthroughMarkdown } from "../lib/prompts";
import type { Walkthrough } from "../lib/types";
import { sfUrn } from "../lib/demo-catalog";

const SAMPLE: Walkthrough = {
  title: "Investigate a revenue discrepancy",
  goal: "Trace a suspicious revenue number from the dashboard back to source tables.",
  steps: [
    {
      order: 1,
      title: "Start at the revenue fact table",
      urn: sfUrn("fct_revenue"),
      entityType: "dataset",
      instruction: "Open fct_revenue and read the description.",
      why: "It is the canonical revenue source, owned by Priya Patel.",
      lookFor: "net_amount_usd vs gross_amount_usd",
    },
    {
      order: 2,
      title: "Check upstream refunds",
      urn: sfUrn("stg_payments"),
      entityType: "dataset",
      instruction: "Inspect the staging payments model feeding fct_revenue.",
      why: "Refund handling happens upstream; a filter change here shifts net revenue.",
    },
  ],
  quiz: [{ question: "Which column should you use for net revenue?", answer: "net_amount_usd" }],
};

function extractJsonFence(text: string): unknown {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(matches[i][1]);
    } catch {
      /* try earlier fence */
    }
  }
  return null;
}

describe("walkthrough round trip", () => {
  it("walkthroughMarkdown embeds a parseable JSON copy of the walkthrough", () => {
    const md = walkthroughMarkdown(SAMPLE);
    expect(md).toContain("# Investigate a revenue discrepancy");
    expect(md).toContain("Step 2: Check upstream refunds");
    const parsed = extractJsonFence(md) as Walkthrough;
    expect(parsed).toEqual(SAMPLE);
  });

  it("saved walkthrough is listed via document search and readable via get_entities", () => {
    const md = walkthroughMarkdown(SAMPLE);
    const saved = JSON.parse(
      callDemoTool("save_document", {
        document_type: "Note",
        title: SAMPLE.title,
        content: md,
        topics: ["training", "walkthrough"],
      }).content
    );
    expect(saved.success).toBe(true);

    // Trainee list: the same query GET /api/walkthroughs uses.
    const search = JSON.parse(
      callDemoTool("search", { query: "training walkthrough", entity_type: "document" }).content
    );
    expect(search.results.some((r: { urn: string }) => r.urn === saved.urn)).toBe(true);

    // Trainee open: fetch content and recover the machine-readable steps.
    const entities = JSON.parse(callDemoTool("get_entities", { urns: [saved.urn] }).content);
    const doc = entities.entities[0];
    const parsed = extractJsonFence(doc.content) as Walkthrough;
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0].urn).toBe(sfUrn("fct_revenue"));
  });
});
