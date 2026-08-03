import { beforeEach, describe, expect, it, vi } from "vitest";
import { callToolOverGraphQL } from "../lib/mcp-over-graphql";

/**
 * The GraphQL shim exists so the loop can run where a stdio subprocess cannot —
 * which means it is only ever exercised on a serverless deployment, where a
 * silent mismatch between the argument names the callers use and the ones the
 * shim reads would look like DataHub refusing the write.
 *
 * That is exactly what happened: every caller in this repo passes `entity_urns`
 * and the shim read `resource_urn`, so `add_tags` would have failed on every
 * real call. These tests pin the mapping in both directions.
 */

let sent: { query: string; variables: Record<string, unknown> }[] = [];
let response: { data?: unknown; errors?: { message: string }[] } = {};

vi.mock("../lib/datahub-graphql", () => ({
  datahubGraphQL: async (query: string, variables: Record<string, unknown>) => {
    sent.push({ query, variables });
    return response;
  },
}));

const DATASET = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)";
const OTHER = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.mrr_monthly,PROD)";

beforeEach(() => {
  sent = [];
  response = {};
});

describe("tools it does not implement", () => {
  it("returns null rather than an error, so the caller can tell them apart", async () => {
    // "This shim does not cover that" and "the catalog said no" are different
    // problems and only one of them is the catalog's.
    expect(await callToolOverGraphQL("get_lineage", { urn: DATASET })).toBeNull();
    expect(await callToolOverGraphQL("get_usage_stats", {})).toBeNull();
  });
});

describe("add_tags", () => {
  it("reads the argument name its callers actually use", async () => {
    response = { data: { batchAddTags: true } };
    const result = await callToolOverGraphQL("add_tags", {
      tag_urns: ["urn:li:tag:StaleRunbook"],
      entity_urns: [DATASET, OTHER],
    });

    expect(result?.isError).toBe(false);
    expect(sent[0].query).toContain("batchAddTags");
    expect(sent[0].variables).toEqual({
      input: {
        tagUrns: ["urn:li:tag:StaleRunbook"],
        resources: [{ resourceUrn: DATASET }, { resourceUrn: OTHER }],
      },
    });
  });

  it("also accepts the singular spelling", async () => {
    response = { data: { batchAddTags: true } };
    await callToolOverGraphQL("add_tags", { tag_urns: ["urn:li:tag:StaleRunbook"], resource_urn: DATASET });
    expect((sent[0].variables.input as { resources: unknown[] }).resources).toEqual([{ resourceUrn: DATASET }]);
  });

  it("refuses rather than sending a malformed mutation", async () => {
    expect(await callToolOverGraphQL("add_tags", { tag_urns: ["urn:li:tag:X"] })).toMatchObject({ isError: true });
    expect(sent).toHaveLength(0);
  });
});

describe("get_entities", () => {
  it("reports a URN the catalog does not hold as not found", async () => {
    // GraphQL answers an un-ingested URN with a stub — right type, every aspect
    // null — rather than with nothing. Passing that up would report a deleted
    // dataset as present and swallow the entity-missing finding.
    response = { data: { entities: [{ urn: DATASET, exists: false }] } };
    const result = await callToolOverGraphQL("get_entities", { urns: [DATASET] });
    expect(JSON.parse(result!.content)).toEqual({ entities: [], error: "not found in catalog" });
  });

  it("passes a real entity through unwrapped when there is exactly one", async () => {
    response = { data: { entities: [{ urn: DATASET, exists: true, name: "fct_revenue" }] } };
    const result = await callToolOverGraphQL("get_entities", { urns: [DATASET] });
    expect(JSON.parse(result!.content)).toMatchObject({ name: "fct_revenue" });
  });

  it("accepts the singular `urn` that get_dataset_health is called with", async () => {
    response = { data: { entities: [{ urn: DATASET, exists: true }] } };
    await callToolOverGraphQL("get_dataset_health", { urn: DATASET });
    expect(sent[0].variables).toEqual({ urns: [DATASET] });
  });
});

describe("save_document", () => {
  it("maps the tool's arguments onto createDocument", async () => {
    response = { data: { createDocument: "urn:li:document:shared-abc" } };
    const result = await callToolOverGraphQL("save_document", {
      document_type: "Note",
      title: "Stale runbook: x",
      content: "# body",
      related_assets: [DATASET],
    });

    expect(sent[0].query).toContain("createDocument");
    expect(sent[0].variables).toEqual({
      input: {
        title: "Stale runbook: x",
        subType: "Note",
        contents: { text: "# body" },
        relatedAssets: [{ asset: DATASET }],
      },
    });
    // The caller pulls the URN out of this text — it has to be in it.
    expect(result!.content).toContain("urn:li:document:shared-abc");
  });

  it("fails loudly when DataHub returns no URN, rather than reporting a write", async () => {
    response = { data: { createDocument: null } };
    expect(await callToolOverGraphQL("save_document", { title: "x", content: "y" })).toMatchObject({
      isError: true,
    });
  });
});
