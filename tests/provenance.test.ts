import { beforeAll, describe, expect, it } from "vitest";
import { sfUrn } from "../lib/demo-catalog";
import { detectDecay, snapshotEntity } from "../lib/decay";
import {
  ASPECTS,
  chainLine,
  extractClaims,
  humanOwners,
  pin,
  verifyClaims,
  versionOf,
} from "../lib/provenance";
import type { EntitySnapshot, Handoff, HandoffStep } from "../lib/types";

beforeAll(() => {
  process.env.DEMO_MODE = "true";
});

const FCT_REVENUE = sfUrn("fct_revenue");
const PAYMENT_HEALTH = sfUrn("payment_health_daily");

function snapshot(urn: string, over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    urn,
    name: "fct_revenue",
    exists: true,
    fields: ["net_amount_usd", "revenue_date"],
    owners: ["Priya Patel (Payments Data Lead, urn:li:corpuser:priya.patel)"],
    deprecated: false,
    openIncidents: 0,
    failingAssertions: 0,
    capturedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function handoff(steps: HandoffStep[], snapshots?: Record<string, EntitySnapshot>): Handoff {
  return {
    id: "test-runbook",
    title: "Test runbook",
    author: "Priya Patel",
    summary: "",
    steps,
    recorded: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    ...(snapshots ? { snapshots } : {}),
  };
}

describe("versionOf", () => {
  it("is deterministic for the same catalog facts", () => {
    expect(versionOf(snapshot(FCT_REVENUE))).toEqual(versionOf(snapshot(FCT_REVENUE)));
  });

  it("ignores the order the catalog happens to return fields and owners in", () => {
    const a = versionOf(snapshot(FCT_REVENUE, { fields: ["a", "b"], owners: ["x", "y"] }));
    const b = versionOf(snapshot(FCT_REVENUE, { fields: ["b", "a"], owners: ["y", "x"] }));
    expect(a).toEqual(b);
  });

  it("moves only the aspect that actually changed", () => {
    const before = versionOf(snapshot(FCT_REVENUE));
    const after = versionOf(snapshot(FCT_REVENUE, { fields: ["net_amount_usd"] }));
    expect(after.aspects.schema).not.toBe(before.aspects.schema);
    expect(after.aspects.ownership).toBe(before.aspects.ownership);
    expect(after.aspects.deprecation).toBe(before.aspects.deprecation);
    expect(after.entity).not.toBe(before.entity);
  });

  it("treats a rewritten deprecation note as a change, since it names the replacement", () => {
    const a = versionOf(snapshot(FCT_REVENUE, { deprecated: true, deprecationNote: "Use fct_revenue_v2." }));
    const b = versionOf(snapshot(FCT_REVENUE, { deprecated: true, deprecationNote: "Use fct_revenue_v3." }));
    expect(a.aspects.deprecation).not.toBe(b.aspects.deprecation);
  });

  it("covers every aspect a claim can be pinned to", () => {
    const version = versionOf(snapshot(FCT_REVENUE));
    for (const aspect of ASPECTS) expect(version.aspects[aspect]).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("extractClaims", () => {
  const step: HandoffStep = {
    title: "Pull net revenue",
    instruction: "Sum net_amount_usd for the period.",
    why: "Gross includes refunds.",
    urn: FCT_REVENUE,
    tips: "If it looks short, ping Priya Patel.",
  };

  it("claims only the columns the step actually reads", () => {
    const claims = extractClaims(handoff([step]), { [FCT_REVENUE]: snapshot(FCT_REVENUE) });
    const columns = claims.filter((c) => c.kind === "column-exists").map((c) => c.subject);
    expect(columns).toEqual(["net_amount_usd"]);
  });

  it("claims the owner the step names, and pins it to the ownership aspect", () => {
    const claims = extractClaims(handoff([step]), { [FCT_REVENUE]: snapshot(FCT_REVENUE) });
    const owner = claims.find((c) => c.kind === "owner-current");
    expect(owner?.subject).toBe("Priya Patel");
    expect(owner?.validatedAgainst?.aspect).toBe("ownership");
    expect(owner?.validatedAgainst?.at).toBe("2026-07-01T00:00:00.000Z");
  });

  it("does not claim health when the entity was already unhealthy at record time", () => {
    const claims = extractClaims(handoff([step]), {
      [FCT_REVENUE]: snapshot(FCT_REVENUE, { failingAssertions: 1 }),
    });
    expect(claims.some((c) => c.kind === "healthy")).toBe(false);
  });

  it("gives every claim a stable id across runs", () => {
    const once = extractClaims(handoff([step]), { [FCT_REVENUE]: snapshot(FCT_REVENUE) });
    const twice = extractClaims(handoff([step]), { [FCT_REVENUE]: snapshot(FCT_REVENUE) });
    expect(once.map((c) => c.id)).toEqual(twice.map((c) => c.id));
  });

  it("falls back to live state for a runbook recorded before snapshotting shipped", () => {
    const claims = extractClaims(handoff([step]), {}, { [FCT_REVENUE]: snapshot(FCT_REVENUE) });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].validatedAgainst).toBeDefined();
  });
});

describe("verifyClaims", () => {
  const baseline = { [FCT_REVENUE]: snapshot(FCT_REVENUE) };
  const step: HandoffStep = {
    title: "Pull net revenue",
    instruction: "Sum net_amount_usd for the period.",
    why: "Canonical.",
    urn: FCT_REVENUE,
    tips: "Ping Priya Patel if it looks short.",
  };
  const claims = extractClaims(handoff([step]), baseline);

  it("holds every claim when nothing has moved, and says the aspect is unchanged", () => {
    const verdicts = verifyClaims(claims, baseline);
    expect(verdicts.every((v) => v.status === "holds")).toBe(true);
    expect(verdicts.every((v) => v.aspectUnchanged)).toBe(true);
  });

  it("breaks the column claim when the column goes, and leaves the others alone", () => {
    const verdicts = verifyClaims(claims, {
      [FCT_REVENUE]: snapshot(FCT_REVENUE, { fields: ["revenue_date"] }),
    });
    const column = verdicts.find((v) => v.claimId.startsWith("column-exists"));
    expect(column?.status).toBe("broken");
    expect(column?.aspectUnchanged).toBe(false);
    expect(verdicts.find((v) => v.claimId.startsWith("owner-current"))?.status).toBe("holds");
  });

  it("breaks the owner claim when the named owner is replaced", () => {
    const verdicts = verifyClaims(claims, {
      [FCT_REVENUE]: snapshot(FCT_REVENUE, { owners: ["Sarah Chen (urn:li:corpuser:sarah.chen)"] }),
    });
    const owner = verdicts.find((v) => v.claimId.startsWith("owner-current"));
    expect(owner?.status).toBe("broken");
    expect(owner?.detail).toContain("Sarah Chen");
  });

  it("matches an owner across display-name and username spellings", () => {
    const verdicts = verifyClaims(claims, {
      [FCT_REVENUE]: snapshot(FCT_REVENUE, { owners: ["priya.patel"] }),
    });
    expect(verdicts.find((v) => v.claimId.startsWith("owner-current"))?.status).toBe("holds");
  });

  it("reports unverified rather than broken when the catalog could not be read", () => {
    const verdicts = verifyClaims(claims, {});
    expect(verdicts.every((v) => v.status === "unverified")).toBe(true);
  });

  it("breaks every claim on an entity that has vanished", () => {
    const verdicts = verifyClaims(claims, { [FCT_REVENUE]: snapshot(FCT_REVENUE, { exists: false }) });
    expect(verdicts.every((v) => v.status === "broken")).toBe(true);
  });
});

describe("the chain a reader sees", () => {
  it("names the aspect version then and now on each side of the arrow", () => {
    const baseline = { [FCT_REVENUE]: snapshot(FCT_REVENUE) };
    const claims = extractClaims(
      handoff([{ title: "s", instruction: "Sum net_amount_usd.", why: "y", urn: FCT_REVENUE }]),
      baseline
    );
    const after = { [FCT_REVENUE]: snapshot(FCT_REVENUE, { fields: ["revenue_date"] }) };
    const verdicts = verifyClaims(claims, after);
    const column = claims.find((c) => c.kind === "column-exists")!;
    const line = chainLine(column, verdicts.find((v) => v.claimId === column.id)!);

    expect(line).toContain("✗");
    expect(line).toContain(pin(baseline[FCT_REVENUE], "schema").aspectVersion);
    expect(line).toContain(pin(after[FCT_REVENUE], "schema").aspectVersion);
  });
});

describe("humanOwners", () => {
  it("keeps one readable name per owner instead of every identity the catalog holds", () => {
    expect(humanOwners(["Priya Patel", "priya.patel@northbeam.io", "urn:li:corpuser:priya.patel", "priya.patel"])).toEqual(
      ["Priya Patel"]
    );
  });

  it("falls back to the username when there is no display name", () => {
    expect(humanOwners(["mike.rodriguez", "urn:li:corpuser:mike.rodriguez"])).toEqual(["mike.rodriguez"]);
  });
});

describe("detectDecay carries the provenance through", () => {
  it("attaches claims, verdicts and live versions to the report", async () => {
    const report = await detectDecay(
      handoff([{ title: "Pull revenue", instruction: "Use net_amount_usd.", why: "Canonical.", urn: FCT_REVENUE }], {
        [FCT_REVENUE]: snapshot(FCT_REVENUE),
      })
    );
    expect(report.claims?.length).toBeGreaterThan(0);
    expect(report.verdicts?.length).toBe(report.claims?.length);
    expect(report.versions?.[FCT_REVENUE]?.entity).toMatch(/^[0-9a-f]{12}$/);
  });

  it("links each finding back to the claim it broke", async () => {
    const report = await detectDecay(
      handoff(
        [{ title: "Check health", instruction: "Open payment_health_daily.", why: "Catch outages.", urn: PAYMENT_HEALTH }],
        {
          [PAYMENT_HEALTH]: snapshot(PAYMENT_HEALTH, { name: "payment_health_daily", fields: ["date"], owners: [] }),
        }
      )
    );
    const finding = report.findings.find((f) => f.kind === "failing-assertion");
    expect(finding?.claimId).toBeDefined();
    const claim = report.claims?.find((c) => c.id === finding?.claimId);
    expect(claim?.kind).toBe("healthy");
    expect(claim?.validatedAgainst?.aspect).toBe("health");
  });

  it("fingerprints what it reads from the catalog", async () => {
    const snap = await snapshotEntity(FCT_REVENUE);
    expect(snap.version?.entity).toMatch(/^[0-9a-f]{12}$/);
    // Recomputable: the stored version is exactly what the facts hash to.
    expect(versionOf(snap)).toEqual(snap.version);
  });
});
