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

  it("exposes get_dataset_health and get_usage_stats", () => {
    const names = DEMO_TOOLS.map((t) => t.name);
    expect(names).toContain("get_dataset_health");
    expect(names).toContain("get_usage_stats");
  });

  it("get_dataset_health flags a deprecated table and an open incident", () => {
    const eventsHealth = call("get_dataset_health", { urn: pgUrn("events") });
    expect(eventsHealth.deprecated?.replacement).toBe(sfUrn("events_sessionized"));
    expect(eventsHealth.healthy).toBe(false);

    const paymentsHealth = call("get_dataset_health", { urn: pgUrn("payments") });
    expect(paymentsHealth.incidents.length).toBeGreaterThan(0);
    expect(paymentsHealth.healthy).toBe(false);

    const healthyHealth = call("get_dataset_health", { urn: sfUrn("dim_customers") });
    expect(healthyHealth.healthy).toBe(true);
  });

  it("get_dataset_health surfaces failing assertions", () => {
    const { assertions, healthy } = call("get_dataset_health", { urn: sfUrn("payment_health_daily") });
    expect(assertions.some((a: { status: string }) => a.status === "fail")).toBe(true);
    expect(healthy).toBe(false);
  });

  it("get_usage_stats returns query volume and top users", () => {
    const { usage } = call("get_usage_stats", { urn: sfUrn("mrr_monthly") });
    expect(usage.queryCount30d).toBeGreaterThan(0);
    expect(usage.topUsers.length).toBeGreaterThan(0);
  });

  it("search and get_entities surface related glossary terms", () => {
    const { results } = call("search", { query: "MRR", entity_type: "glossaryTerm" });
    const mrr = results.find((r: { urn: string }) => r.urn === "urn:li:glossaryTerm:MRR");
    expect(mrr.relatedTerms).toContain("ARR");

    const { entities } = call("get_entities", { urns: ["urn:li:glossaryTerm:MRR"] });
    expect(entities[0].relatedTerms).toContain("ARR");
  });

  it("deprecated datasets surface inline on search and get_entities, undeprecated ones don't", () => {
    const { results } = call("search", { query: "event firehose" });
    const eventsResult = results.find((r: { urn: string }) => r.urn === pgUrn("events"));
    expect(eventsResult.deprecated).toBeTruthy();

    const { entities } = call("get_entities", { urns: [sfUrn("dim_customers")] });
    expect(entities[0].deprecated).toBeUndefined();
  });

  it("save_document accepts a DescriptionProposal linked to a subject entity", () => {
    const saved = call("save_document", {
      document_type: "DescriptionProposal",
      title: "Proposed description for payment_health_daily.provider",
      content: "stripe | paypal — the payment processor for this row.",
      subject_urn: sfUrn("payment_health_daily"),
    });
    expect(saved.success).toBe(true);
    expect(saved.message).toContain(sfUrn("payment_health_daily"));
  });
});
