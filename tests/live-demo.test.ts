import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hosted demo reads a real catalog when one is configured. That is the point
 * of it — a reader who cannot tell a live read from a replay has no reason to
 * believe either — but it is also the part that could quietly go wrong in ways
 * nobody notices on a public URL.
 *
 * Three things are pinned here. It must not read a catalog it was told not to
 * touch. It must not let one visitor's breaking changes reach another visitor.
 * And the report has to come out of the same engine as everything else, against
 * whatever the catalog actually said, rather than a stored answer.
 */

const snapshotEntity = vi.hoisted(() => vi.fn());
const datahubGraphQL = vi.hoisted(() => vi.fn());
const gmsReachable = vi.hoisted(() => vi.fn());

vi.mock("../lib/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mcp")>()),
  isDemoMode: () => process.env.DEMO_MODE === "true",
}));

vi.mock("../lib/datahub-graphql", () => ({ datahubGraphQL, gmsReachable }));

vi.mock("../lib/decay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/decay")>();
  return { ...actual, snapshotEntity };
});

import { demoRunbook, DEMO_URNS } from "../lib/demo-drift";
import { liveDemoAvailable, resetLiveDemoCache, revalidateLive } from "../lib/live-demo";
import { versionOf } from "../lib/provenance";
import type { EntitySnapshot } from "../lib/types";

/** The catalog as the fake DataHub holds it: exactly as recorded, so a clean run is clean. */
function catalogAsRecorded(): Record<string, EntitySnapshot> {
  const recorded = demoRunbook().snapshots ?? {};
  const now = new Date().toISOString();
  const out: Record<string, EntitySnapshot> = {};
  for (const [urn, snapshot] of Object.entries(recorded)) {
    const copy: EntitySnapshot = { ...JSON.parse(JSON.stringify(snapshot)), capturedAt: now };
    copy.version = versionOf(copy);
    out[urn] = copy;
  }
  return out;
}

let catalog: Record<string, EntitySnapshot>;

beforeEach(() => {
  resetLiveDemoCache();
  catalog = catalogAsRecorded();
  process.env.DEMO_MODE = "false";
  process.env.DATAHUB_GMS_URL = "http://datahub.test:8080";
  process.env.DEMO_LIVE_TTL_MS = "0";
  gmsReachable.mockResolvedValue(true);
  datahubGraphQL.mockResolvedValue({ data: { appConfig: { appVersion: "v1.5.0.6" } } });
  snapshotEntity.mockImplementation(async (urn: string) =>
    catalog[urn] ? JSON.parse(JSON.stringify(catalog[urn])) : { urn, exists: false, fields: [], owners: [] },
  );
});

afterEach(() => {
  delete process.env.DEMO_MODE;
  delete process.env.DATAHUB_GMS_URL;
  delete process.env.DEMO_LIVE_TTL_MS;
  vi.clearAllMocks();
});

describe("the live-catalog demo", () => {
  it("stays off when the deployment is in fixture mode, reachable GMS or not", async () => {
    process.env.DEMO_MODE = "true";
    resetLiveDemoCache();
    expect(await liveDemoAvailable()).toBe(false);
    expect(gmsReachable).not.toHaveBeenCalled();
  });

  it("stays off when no catalog is configured", async () => {
    delete process.env.DATAHUB_GMS_URL;
    resetLiveDemoCache();
    expect(await liveDemoAvailable()).toBe(false);
  });

  it("reads the catalog during the request and says so", async () => {
    const { live } = await revalidateLive([]);
    expect(snapshotEntity).toHaveBeenCalledTimes(3);
    expect(live.gms).toBe("http://datahub.test:8080");
    expect(live.datahubVersion).toBe("v1.5.0.6");
    expect(live.entities.map((e) => e.urn).sort()).toEqual(Object.values(DEMO_URNS).sort());
    // A fingerprint computed from what the catalog just returned, not stored.
    for (const entity of live.entities) expect(entity.version).toMatch(/^[0-9a-f]{12}$/);
    expect(Date.parse(live.readAt)).toBeLessThanOrEqual(Date.now());
  });

  it("reports drift that is in the catalog, with nothing selected", async () => {
    // Nobody clicked anything. The catalog moved on its own, which is the whole
    // premise of the project and the one thing a replayed demo cannot show.
    catalog[DEMO_URNS.fctRevenue].fields = catalog[DEMO_URNS.fctRevenue].fields.filter(
      (f) => f !== "net_amount_usd",
    );

    const { report } = await revalidateLive([]);
    const finding = report.findings.find((f) => f.kind === "column-missing");
    expect(finding?.detail).toContain("net_amount_usd");
    expect(report.severity).toBe("broken");
  });

  it("leaves no trace of one visitor's changes on the next", async () => {
    const broken = await revalidateLive(["drop-column", "deprecate"]);
    expect(broken.report.findings.length).toBeGreaterThan(0);

    const next = await revalidateLive([]);
    expect(next.report.findings).toEqual([]);
    expect(next.report.severity).toBe("ok");
  });

  it("never writes to the catalog", async () => {
    await revalidateLive(["drop-column", "rename-column", "deprecate", "remove-owner", "fail-assertion"]);
    // The only GraphQL this path is allowed to send is the version probe.
    for (const [query] of datahubGraphQL.mock.calls) {
      expect(String(query)).not.toMatch(/mutation/i);
    }
  });

  it("shares one read between visitors who arrive together", async () => {
    process.env.DEMO_LIVE_TTL_MS = "60000";
    resetLiveDemoCache();

    const [first, second] = await Promise.all([revalidateLive([]), revalidateLive(["drop-column"])]);
    expect(snapshotEntity).toHaveBeenCalledTimes(3);
    // Same read, and still not each other's catalog.
    expect(first.report.findings).toEqual([]);
    expect(second.report.findings.some((f) => f.kind === "column-missing")).toBe(true);
  });
});
