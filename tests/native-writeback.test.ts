import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIncidentsFor, writeBackNative } from "../lib/native-writeback";
import type { DecayReport, EntitySnapshot, Handoff } from "../lib/types";

/**
 * The action half of the loop: a runbook that would fail if followed becomes a
 * real DataHub incident, assigned to whoever owns the dataset *today*. In the
 * owner-drift case that is precisely the person the runbook has never heard of,
 * which is the point.
 */

// Not demo mode — the write-back deliberately refuses to touch a catalog it did
// not read — but the tag call must not reach a real MCP server either.
vi.mock("../lib/mcp", () => ({
  isDemoMode: () => false,
  callDataHubTool: async () => ({ content: "ok", isError: false }),
}));

const URN = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)";

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

let calls: Call[] = [];
let openIncidents: { urn: string; title: string }[] = [];

function named(fragment: string): Call[] {
  return calls.filter((c) => c.query.includes(fragment));
}

beforeEach(() => {
  calls = [];
  openIncidents = [];

  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Call;
    calls.push(body);
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

    if (body.query.includes("__typename")) return reply({ __typename: "Query" });
    if (body.query.trim().startsWith("query($urn: String!) { tag")) return reply({ tag: { urn: "t" } });
    if (body.query.includes("createTag")) return reply({ createTag: "t" });
    if (body.query.includes("incidents(state: ACTIVE")) {
      return reply({ dataset: { incidents: { incidents: openIncidents } } });
    }
    if (body.query.includes("raiseIncident")) return reply({ raiseIncident: "urn:li:incident:new" });
    if (body.query.includes("updateIncidentStatus")) return reply({ updateIncidentStatus: true });
    if (body.query.includes("updateIncident")) return reply({ updateIncident: true });
    return reply({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const handoff: Handoff = {
  id: "monthly-close",
  title: "Monthly close",
  author: "Priya Patel",
  summary: "",
  createdAt: "2026-07-01T00:00:00.000Z",
  recorded: [],
  steps: [{ title: "Pull revenue", instruction: "Sum net_amount_usd.", why: "Canonical.", urn: URN }],
};

const report: DecayReport = {
  handoffId: "monthly-close",
  checkedAt: "2026-08-01T00:00:00.000Z",
  severity: "broken",
  stepsChecked: 1,
  entitiesChecked: 1,
  hadSnapshot: true,
  findings: [
    {
      stepIndex: 0,
      stepTitle: "Pull revenue",
      urn: URN,
      severity: "broken",
      kind: "column-missing",
      detail: "Column `net_amount_usd` is referenced by this step but no longer exists on fct_revenue.",
      claimId: "column-exists:abc123",
    },
  ],
  claims: [
    {
      id: "column-exists:abc123",
      stepIndex: 0,
      stepTitle: "Pull revenue",
      urn: URN,
      kind: "column-exists",
      subject: "net_amount_usd",
      statement: "fct_revenue has a column `net_amount_usd`, which this step reads.",
      validatedAgainst: {
        urn: URN,
        aspect: "schema",
        aspectVersion: "aaaa11112222",
        entityVersion: "e1",
        at: "2026-07-01T00:00:00.000Z",
      },
    },
  ],
  verdicts: [
    {
      claimId: "column-exists:abc123",
      status: "broken",
      aspectUnchanged: false,
      detail: "gone",
      checkedAgainst: { urn: URN, aspect: "schema", aspectVersion: "bbbb33334444", entityVersion: "e2", at: "2026-08-01T00:00:00.000Z" },
    },
  ],
};

const live: Record<string, EntitySnapshot> = {
  [URN]: {
    urn: URN,
    name: "fct_revenue",
    exists: true,
    fields: ["net_revenue_usd"],
    owners: ["Sarah Chen"],
    ownerUrns: ["urn:li:corpuser:sarah.chen", "urn:li:corpGroup:data-eng"],
    deprecated: false,
    openIncidents: 0,
    failingAssertions: 0,
    capturedAt: "2026-08-01T00:00:00.000Z",
  },
};

describe("writeBackNative", () => {
  it("assigns the incident to the person who owns the dataset now", async () => {
    const receipt = await writeBackNative(handoff, report, "urn:li:document:note", live);
    expect(receipt.incidents[0]).toMatchObject({ urn: "urn:li:incident:new", reused: false });
    expect(receipt.incidents[0].assignees).toEqual(["urn:li:corpuser:sarah.chen"]);

    const input = named("raiseIncident")[0].variables.input as { assigneeUrns: string[]; type: string };
    // Groups can own a dataset but cannot be assigned an incident.
    expect(input.assigneeUrns).toEqual(["urn:li:corpuser:sarah.chen"]);
    expect(input.type).toBe("DATA_SCHEMA");
  });

  it("puts the provenance chain and the proposed correction in the incident body", async () => {
    await writeBackNative(handoff, report, "urn:li:document:note", live, {
      summary: "1 edit derived from the catalog",
      url: "https://example.com/pr/1",
    });
    const { description } = named("raiseIncident")[0].variables.input as { description: string };

    expect(description).toContain("schema@aaaa11112222");
    expect(description).toContain("schema@bbbb33334444");
    expect(description).toContain("Proposed correction: 1 edit derived from the catalog");
    expect(description).toContain("https://example.com/pr/1");
    expect(description).toContain("urn:li:document:note");
  });

  it("refreshes the open incident instead of opening a second one every night", async () => {
    openIncidents = [{ urn: "urn:li:incident:existing", title: "Stale runbook: Monthly close" }];
    const receipt = await writeBackNative(handoff, report, undefined, live);

    expect(named("raiseIncident")).toHaveLength(0);
    expect(receipt.incidents[0]).toMatchObject({ urn: "urn:li:incident:existing", reused: true });
    // Ownership may have moved again since it was opened, so re-assign on update.
    const input = named("updateIncident")[0].variables.input as { assigneeUrns: string[] };
    expect(input.assigneeUrns).toEqual(["urn:li:corpuser:sarah.chen"]);
  });

  it("raises nothing for a runbook that only warns", async () => {
    const receipt = await writeBackNative(handoff, { ...report, severity: "warning", findings: [] }, undefined, live);
    expect(receipt.attempted).toBe(false);
    expect(named("raiseIncident")).toHaveLength(0);
  });

  it("leaves the incident unassigned rather than guessing when nobody owns the dataset", async () => {
    const orphaned = { [URN]: { ...live[URN], owners: [], ownerUrns: [] } };
    const receipt = await writeBackNative(handoff, report, undefined, orphaned);
    expect(receipt.incidents[0].assignees).toEqual([]);
    expect((named("raiseIncident")[0].variables.input as Record<string, unknown>).assigneeUrns).toBeUndefined();
  });
});

describe("resolveIncidentsFor", () => {
  it("closes the incidents this tool opened once the runbook validates clean", async () => {
    openIncidents = [{ urn: "urn:li:incident:ours", title: "Stale runbook: Monthly close" }];
    const resolved = await resolveIncidentsFor(handoff, [URN]);

    expect(resolved).toEqual([{ urn: "urn:li:incident:ours", datasetUrn: URN }]);
    const input = named("updateIncidentStatus")[0].variables.input as { state: string; message: string };
    expect(input.state).toBe("RESOLVED");
    expect(input.message).toMatch(/holds again/i);
  });

  it("leaves incidents raised by anyone else alone", async () => {
    // A detector that closes other people's incidents is worse than one that
    // never closes anything.
    openIncidents = [
      { urn: "urn:li:incident:theirs", title: "Freshness breach on fct_revenue" },
      { urn: "urn:li:incident:other-runbook", title: "Stale runbook: Weekly refresh" },
    ];
    const resolved = await resolveIncidentsFor(handoff, [URN]);

    expect(resolved).toEqual([]);
    expect(named("updateIncidentStatus")).toHaveLength(0);
  });
});
