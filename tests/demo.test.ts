import { describe, expect, it } from "vitest";
import { DEMO_DATASETS, DEMO_LINEAGE, pgUrn, sfUrn } from "../lib/demo-catalog";
import { callDemoTool, DEMO_TOOLS } from "../lib/demo-mcp";

function call(name: string, args: Record<string, unknown>) {
  const result = callDemoTool(name, args);
  expect(result.isError).toBe(false);
  return JSON.parse(result.content);
}

describe("demo mode tool surface", () => {
  it("exposes the same tools the agent prompts reference", () => {
    const names = DEMO_TOOLS.map((t) => t.name);
    for (const expected of ["search", "get_entities", "get_lineage", "get_dataset_queries", "save_document"]) {
      expect(names).toContain(expected);
    }
  });

  it("search finds revenue datasets and the MRR glossary term", () => {
    const { results } = call("search", { query: "revenue MRR" });
    const urns = results.map((r: { urn: string }) => r.urn);
    expect(urns).toContain(sfUrn("fct_revenue"));
    expect(urns).toContain(sfUrn("mrr_monthly"));
    expect(urns).toContain("urn:li:glossaryTerm:MRR");
  });

  it("search can filter to a single entity type", () => {
    const { results } = call("search", { query: "payments", entity_type: "corpuser" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.type).toBe("corpuser");
  });

  it("get_entities returns schema fields and owners for a dataset", () => {
    const { entities } = call("get_entities", { urns: [sfUrn("fct_revenue")] });
    expect(entities).toHaveLength(1);
    const entity = entities[0];
    expect(entity.owners.join(" ")).toContain("Priya Patel");
    const fieldPaths = entity.schema.map((f: { fieldPath: string }) => f.fieldPath);
    expect(fieldPaths).toContain("net_amount_usd");
  });

  it("get_lineage walks upstream and downstream correctly", () => {
    const up = call("get_lineage", { urn: sfUrn("mrr_monthly"), direction: "upstream" });
    expect(up.hops[0].entities.map((e: { urn: string }) => e.urn)).toEqual([sfUrn("fct_revenue")]);

    const down = call("get_lineage", { urn: pgUrn("users"), direction: "downstream", max_hops: 3 });
    const reachable = down.hops.flatMap((h: { entities: { urn: string }[] }) => h.entities.map((e) => e.urn));
    expect(reachable).toContain(sfUrn("stg_users"));
    expect(reachable).toContain(sfUrn("dim_customers"));
  });

  it("get_dataset_queries returns real saved SQL", () => {
    const { queries } = call("get_dataset_queries", { urn: sfUrn("fct_churn") });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0].statement).toContain("churn_rate");
  });

  it("save_document persists and becomes searchable", () => {
    const saved = call("save_document", {
      document_type: "Note",
      title: "Week-1 onboarding zorbfax plan",
      content: "Day 1: read fct_revenue docs.",
      topics: ["onboarding"],
    });
    expect(saved.success).toBe(true);

    const { results } = call("search", { query: "zorbfax", entity_type: "document" });
    expect(results.some((r: { urn: string }) => r.urn === saved.urn)).toBe(true);
  });

  it("unknown tools and unknown datasets fail gracefully", () => {
    expect(callDemoTool("nonexistent_tool", {}).isError).toBe(true);
    const lineage = call("get_lineage", { urn: "urn:li:dataset:bogus", direction: "upstream" });
    expect(lineage.error).toBeTruthy();
  });

  it("fixture catalog matches the seed script's shape", () => {
    expect(DEMO_DATASETS).toHaveLength(14);
    expect(Object.keys(DEMO_LINEAGE)).toHaveLength(8);
  });
});
