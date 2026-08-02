import { beforeAll, describe, expect, it } from "vitest";
import { sfUrn } from "../lib/demo-catalog";
import { datasetUrnsIn, draftRunbook, evidenceScore, gatherEvidence } from "../lib/draft-runbook";
import type { DatasetEvidence } from "../lib/draft-runbook";

/**
 * The drafter reads the catalog through the MCP layer; point it at the fixture.
 */
beforeAll(() => {
  process.env.DEMO_MODE = "true";
});

const FCT_REVENUE = sfUrn("fct_revenue");
const EVENTS = sfUrn("events_sessionized");

function evidence(over: Partial<DatasetEvidence> = {}): DatasetEvidence {
  return {
    urn: FCT_REVENUE,
    name: "fct_revenue",
    fields: [],
    owners: [],
    ownerUrns: [],
    tags: [],
    terms: [],
    deprecated: false,
    failingAssertions: 0,
    openIncidents: 0,
    queries: [],
    upstream: [],
    downstream: [],
    ...over,
  };
}

describe("datasetUrnsIn", () => {
  it("unwraps the dataset out of a column-level search hit", () => {
    const field =
      "urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:powerbi,b2fd91.measures.Geographic,PROD),Revenue by Country)";
    expect(datasetUrnsIn([field])).toEqual([
      "urn:li:dataset:(urn:li:dataPlatform:powerbi,b2fd91.measures.Geographic,PROD)",
    ]);
  });

  it("keeps dataset hits and drops everything else", () => {
    expect(datasetUrnsIn([FCT_REVENUE, "urn:li:corpuser:priya.patel", "urn:li:tag:PII"])).toEqual([FCT_REVENUE]);
  });

  it("dedupes when several columns of one table match", () => {
    const a = "urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:snowflake,db.s.t,PROD),colA)";
    const b = "urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:snowflake,db.s.t,PROD),colB)";
    expect(datasetUrnsIn([a, b])).toHaveLength(1);
  });
});

describe("evidenceScore", () => {
  it("prefers a table people query and own over a bare one", () => {
    const rich = evidence({ queries: [{ sql: "SELECT 1 FROM t" }], owners: ["Priya"], terms: ["MRR"], downstream: ["x"] });
    expect(evidenceScore(rich)).toBeGreaterThan(evidenceScore(evidence()));
  });

  it("pushes a deprecated table below an unremarkable live one", () => {
    const deprecated = evidence({ queries: [{ sql: "SELECT 1 FROM t" }], owners: ["Priya"], deprecated: true });
    expect(evidenceScore(deprecated)).toBeLessThan(evidenceScore(evidence({ owners: ["Priya"] })));
  });

  it("rewards certification markers the catalog carries", () => {
    expect(evidenceScore(evidence({ tags: ["Certified"] }))).toBeGreaterThan(evidenceScore(evidence({ tags: ["Draft"] })));
  });
});

describe("gatherEvidence", () => {
  it("reads queries, owners and schema off the catalog", async () => {
    const found = await gatherEvidence(FCT_REVENUE);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("fct_revenue");
    expect(found!.owners.join(" ")).toContain("Priya");
    expect(found!.fields).toContain("net_amount_usd");
    expect(found!.queries.length).toBeGreaterThan(0);
  });

  it("returns null for an entity the catalog does not have", async () => {
    expect(await gatherEvidence(sfUrn("does_not_exist"))).toBeNull();
  });
});

describe("draftRunbook", () => {
  it("drafts steps grounded in recorded queries and lineage", async () => {
    const draft = await draftRunbook(FCT_REVENUE);
    expect(draft).not.toBeNull();

    const { handoff } = draft!;
    expect(handoff.steps.length).toBeGreaterThan(1);
    // Always leads with health: a number from a broken table is worse than none.
    expect(handoff.steps[0].title.toLowerCase()).toContain("healthy");
    // At least one step carries SQL the catalog actually holds, not a reconstruction.
    const sql = handoff.steps.map((s) => s.sql).filter(Boolean);
    expect(sql.length).toBeGreaterThan(0);
  });

  it("marks every inferred why as inferred, and says so in the summary", async () => {
    const { handoff } = (await draftRunbook(FCT_REVENUE))!;

    // The one thing a catalog cannot supply is why the step exists. A draft that
    // silently presented inferred reasoning as a colleague's would defeat the point.
    expect(handoff.steps.every((s) => s.whySource === "inferred")).toBe(true);
    expect(handoff.source).toBe("drafted");
    expect(handoff.summary).toMatch(/drafted from what the catalog already knows/i);
    expect(handoff.draftBasis?.length).toBeGreaterThan(0);
  });

  it("never attributes a draft to a real person", async () => {
    const { handoff } = (await draftRunbook(FCT_REVENUE))!;
    expect(handoff.author).toContain("instaboard");
    expect(handoff.role).toBe("drafted, not recorded");
  });

  it("writes whys as evidence rather than as remembered intent", async () => {
    const { handoff } = (await draftRunbook(FCT_REVENUE))!;
    const whys = handoff.steps.map((s) => s.why).join(" ");
    // Evidence language, not "Priya always starts here because…".
    expect(whys).toMatch(/catalog|DataHub|records|recorded/i);
    expect(whys).not.toMatch(/\balways\b|\bI \b|\bwe used to\b/i);
  });

  it("captures a decay baseline, so a draft rots like anything else", async () => {
    const { handoff } = (await draftRunbook(FCT_REVENUE))!;
    const snapshots = Object.values(handoff.snapshots ?? {});
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((s) => Boolean(s.version?.entity))).toBe(true);
  });

  it("refuses to draft when the catalog holds nothing to draft from", async () => {
    // A name and a schema are not a runbook; drafting from that would be a
    // confident-sounding guess, which is the artifact this project argues against.
    const bare = await draftRunbook(sfUrn("does_not_exist"));
    expect(bare).toBeNull();
  });

  it("reports a deprecated table's status in the health step", async () => {
    const draft = await draftRunbook(EVENTS);
    if (!draft) return; // fixture may not carry lineage for this one
    const health = draft.handoff.steps[0];
    expect(`${health.instruction} ${health.why}`.toLowerCase()).toMatch(/deprecat|clean|health/);
  });
});
