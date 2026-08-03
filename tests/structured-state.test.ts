import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertionUrnFor, provenanceBlock, writeStructuredState } from "../lib/structured-state";
import type { DecayReport, Handoff } from "../lib/types";

/**
 * The structured write-back is all GraphQL, so these tests stand a fake GMS in
 * front of it and assert on the mutations that come out. That is the part worth
 * pinning: which mutation, with which values, and — the one that actually bites —
 * that upserting this runbook's property values does not wipe another runbook's.
 */

const URN = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)";

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

let calls: Call[] = [];
let existingPropertyValues: string[] = [];
let reachable = true;

function mutationsNamed(fragment: string): Call[] {
  return calls.filter((c) => c.query.includes(fragment));
}

beforeEach(() => {
  calls = [];
  existingPropertyValues = [];
  reachable = true;

  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Call;
    calls.push(body);

    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (!reachable) return new Response(JSON.stringify({ errors: [{ message: "no GMS" }] }), { status: 200 });

    if (body.query.includes("__typename")) return reply({ __typename: "Query" });
    if (body.query.includes("createStructuredProperty")) return reply({ createStructuredProperty: { urn: "p" } });
    if (body.query.includes("structuredProperties {")) {
      return reply({
        dataset: {
          structuredProperties: {
            properties: [
              {
                structuredProperty: { urn: "urn:li:structuredProperty:instaboard_runbook_status" },
                values: existingPropertyValues.map((stringValue) => ({ stringValue })),
              },
            ],
          },
        },
      });
    }
    if (body.query.includes("upsertCustomAssertion")) {
      return reply({ upsertCustomAssertion: { urn: (body.variables.urn as string) ?? "urn:li:assertion:x" } });
    }
    // A result is only reported once the assertion reads back, so the fake
    // catalog has to be able to answer for one it was just asked to create.
    if (body.query.includes("assertion(urn:")) {
      return reply({ assertion: { urn: (body.variables.urn as string) ?? "urn:li:assertion:x" } });
    }
    if (body.query.includes("reportAssertionResult")) return reply({ reportAssertionResult: true });
    if (body.query.includes("upsertStructuredProperties")) return reply({ upsertStructuredProperties: { properties: [] } });
    return reply({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function handoff(): Handoff {
  return {
    id: "monthly-close",
    title: "Monthly close",
    author: "Priya Patel",
    summary: "",
    createdAt: "2026-07-01T00:00:00.000Z",
    recorded: [],
    steps: [{ title: "Pull revenue", instruction: "Sum net_amount_usd.", why: "Canonical.", urn: URN }],
  };
}

function report(over: Partial<DecayReport> = {}): DecayReport {
  return {
    handoffId: "monthly-close",
    checkedAt: "2026-08-01T00:00:00.000Z",
    severity: "ok",
    stepsChecked: 1,
    entitiesChecked: 1,
    hadSnapshot: true,
    findings: [],
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
          entityVersion: "eeee11112222",
          at: "2026-07-01T00:00:00.000Z",
        },
      },
    ],
    verdicts: [
      {
        claimId: "column-exists:abc123",
        status: "holds",
        aspectUnchanged: true,
        detail: "still there",
        checkedAgainst: {
          urn: URN,
          aspect: "schema",
          aspectVersion: "aaaa11112222",
          entityVersion: "eeee11112222",
          at: "2026-08-01T00:00:00.000Z",
        },
      },
    ],
    versions: { [URN]: { entity: "eeee11112222", aspects: { schema: "aaaa11112222", ownership: "b", deprecation: "c", health: "d" } } },
    ...over,
  };
}

const brokenReport = () =>
  report({
    severity: "broken",
    findings: [
      {
        stepIndex: 0,
        stepTitle: "Pull revenue",
        urn: URN,
        severity: "broken",
        kind: "column-missing",
        detail: "Column `net_amount_usd` is referenced by this step but no longer exists on fct_revenue.",
        remedy: "Check whether it was renamed.",
        claimId: "column-exists:abc123",
      },
    ],
    verdicts: [
      {
        claimId: "column-exists:abc123",
        status: "broken",
        aspectUnchanged: false,
        detail: "gone",
        checkedAgainst: {
          urn: URN,
          aspect: "schema",
          aspectVersion: "bbbb33334444",
          entityVersion: "ffff33334444",
          at: "2026-08-01T00:00:00.000Z",
        },
      },
    ],
  });

describe("assertionUrnFor", () => {
  it("is stable, so a nightly sweep reports results against one assertion", () => {
    expect(assertionUrnFor("monthly-close", URN)).toBe(assertionUrnFor("monthly-close", URN));
  });

  it("differs per runbook and per dataset", () => {
    expect(assertionUrnFor("monthly-close", URN)).not.toBe(assertionUrnFor("weekly-close", URN));
    expect(assertionUrnFor("monthly-close", URN)).not.toBe(assertionUrnFor("monthly-close", `${URN}x`));
  });

  it("is recognisable as ours, so decay detection can discount it", () => {
    expect(assertionUrnFor("monthly-close", URN)).toMatch(/^urn:li:assertion:instaboard-/);
  });
});

describe("writeStructuredState", () => {
  it("does nothing at all when GMS is unreachable", async () => {
    reachable = false;
    const receipt = await writeStructuredState(handoff(), report());
    expect(receipt.attempted).toBe(false);
    expect(receipt.assertions).toHaveLength(0);
    expect(mutationsNamed("upsertCustomAssertion")).toHaveLength(0);
  });

  it("reports the assertion passing when the runbook still holds", async () => {
    const receipt = await writeStructuredState(handoff(), report());
    expect(receipt.attempted).toBe(true);
    expect(receipt.assertions).toEqual([{ urn: assertionUrnFor("monthly-close", URN), datasetUrn: URN, result: "SUCCESS" }]);
  });

  /*
   * Found by CI on the showcase datapack, where the assertion URN was new
   * because the catalog was. `upsertCustomAssertion` returns before GMS can
   * answer for what it created, and the run event is rejected — six times in one
   * run — leaving the receipt saying "no assertion written" for a write that had
   * succeeded. Invisible on a machine that has run this before, because the URN
   * is a hash of (runbook, dataset) and the assertion is already there.
   */
  it("waits for a newly created assertion to be readable before reporting against it", async () => {
    let reads = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Call;
      if (body.query.includes("assertion(urn:")) {
        calls.push(body);
        reads += 1;
        // Not there, not there, then there — the window CI hit.
        const assertion = reads >= 3 ? { urn: (body.variables.urn as string) ?? "urn:li:assertion:x" } : null;
        return new Response(JSON.stringify({ data: { assertion } }), { status: 200 });
      }
      return realFetch(url, init as RequestInit);
    });

    const receipt = await writeStructuredState(handoff(), report());

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(receipt.assertions).toEqual([
      { urn: assertionUrnFor("monthly-close", URN), datasetUrn: URN, result: "SUCCESS" },
    ]);
  }, 30_000);

  it("reports it failing, with the specific catalog change and the provenance chain attached", async () => {
    await writeStructuredState(handoff(), brokenReport());
    const result = mutationsNamed("reportAssertionResult")[0].variables.result as {
      type: string;
      properties: { key: string; value: string }[];
    };

    expect(result.type).toBe("FAILURE");
    const props = Object.fromEntries(result.properties.map((p) => [p.key, p.value]));
    expect(props["drift.0.kind"]).toBe("column-missing");
    expect(props["drift.0.detail"]).toContain("net_amount_usd");
    expect(props["drift.0.claim"]).toBe("column-exists:abc123");
    expect(props["drift.0.validatedAgainst"]).toBe("schema@aaaa11112222 on 2026-07-01");
    expect(props["drift.0.nowReads"]).toBe("schema@aaaa11112222");
    expect(props["validation.method"]).toContain("no LLM");
  });

  it("writes the status, the drift and the pin as structured properties", async () => {
    const receipt = await writeStructuredState(handoff(), brokenReport());
    const input = mutationsNamed("upsertStructuredProperties")[0].variables.input as {
      structuredPropertyInputParams: { structuredPropertyUrn: string; values: { stringValue: string }[] }[];
    };
    const byProperty = Object.fromEntries(
      input.structuredPropertyInputParams.map((p) => [p.structuredPropertyUrn.split(":").pop(), p.values.map((v) => v.stringValue)])
    );

    expect(byProperty.instaboard_runbook_status).toEqual(["monthly-close: stale (checked 2026-08-01)"]);
    expect(byProperty.instaboard_runbook_drift[0]).toContain("monthly-close step 1 column-missing");
    expect(byProperty.instaboard_runbook_validated_against[0]).toContain("schema@aaaa11112222 -> schema@bbbb33334444 (broken)");
    expect(receipt.properties[0]).toMatchObject({ datasetUrn: URN, driftValues: 1, pins: 1 });
  });

  it("records a clean re-validation too, so silence means checked rather than unchecked", async () => {
    await writeStructuredState(handoff(), report());
    const input = mutationsNamed("upsertStructuredProperties")[0].variables.input as {
      structuredPropertyInputParams: { values: { stringValue: string }[] }[];
    };
    expect(input.structuredPropertyInputParams[0].values[0].stringValue).toContain("validated (checked 2026-08-01)");
  });

  it("keeps another runbook's values instead of overwriting them", async () => {
    existingPropertyValues = ["other-runbook: stale (checked 2026-05-01)", "monthly-close: validated (checked 2026-05-02)"];
    await writeStructuredState(handoff(), brokenReport());

    const input = mutationsNamed("upsertStructuredProperties")[0].variables.input as {
      structuredPropertyInputParams: { values: { stringValue: string }[] }[];
    };
    const status = input.structuredPropertyInputParams[0].values.map((v) => v.stringValue);
    expect(status).toContain("other-runbook: stale (checked 2026-05-01)");
    expect(status).toContain("monthly-close: stale (checked 2026-08-01)");
    expect(status.filter((v) => v.startsWith("monthly-close"))).toHaveLength(1);
  });

  it("defines the properties on a DataHub that has never seen them", async () => {
    await writeStructuredState(handoff(), report());
    const created = mutationsNamed("createStructuredProperty").map(
      (c) => (c.variables.input as { id: string }).id
    );
    expect(created).toEqual([
      "instaboard_runbook_status",
      "instaboard_runbook_drift",
      "instaboard_revalidation_coverage",
      "instaboard_runbook_validated_against",
    ]);
  });

  it("writes the coverage figure alongside the status, per dataset", async () => {
    const receipt = await writeStructuredState(handoff(), {
      ...report(),
      coverage: {
        stepsTotal: 2,
        stepsValidated: 1,
        stepsPartial: 1,
        stepsUnvalidatable: 0,
        claimsTotal: 5,
        claimsChecked: 4,
        claimsUnvalidatable: 1,
        summary: "1/2 steps validated, 1 with catalog gaps (health)",
        gapUrns: [URN],
        steps: [
          {
            stepIndex: 0,
            stepTitle: "Pull revenue",
            urn: URN,
            state: "partial",
            gaps: ["health"],
            claimsTotal: 3,
            claimsUnvalidatable: 1,
            detail: "fct_revenue: it has no assertions or incidents, so nothing is monitoring it.",
          },
        ],
      },
    });
    expect(receipt.properties[0].coverage).toContain("0/1 steps validated");
    expect(receipt.properties[0].coverage).toContain("catalog gaps: health");
  });
});

describe("provenanceBlock", () => {
  it("renders one chain line per claim on the dataset", () => {
    const block = provenanceBlock(brokenReport(), URN);
    expect(block).toContain("✗ step 1");
    expect(block).toContain("schema@aaaa11112222");
    expect(block).toContain("schema@bbbb33334444");
  });

  it("is empty for a dataset the runbook makes no claims about", () => {
    expect(provenanceBlock(brokenReport(), "urn:li:dataset:(urn:li:dataPlatform:snowflake,other,PROD)")).toBe("");
  });
});
