/**
 * The hosted demo, reading a real catalog instead of a fixture.
 *
 * `demo-drift.ts` validates the sample runbook against a baseline written out
 * in code. That is honest — it says so, and the engine it calls is the real one
 * — but a reader cannot tell a fixture from a recording, and the fair complaint
 * is that neither can they tell either one from a script of the answer.
 *
 * This module removes the fixture from the *current* side of the comparison.
 * Every request reads the three datasets the runbook names out of a live
 * DataHub, right then, and diffs the runbook's record-time snapshots against
 * what the catalog says now. The fingerprints in the response were computed
 * during that request from aspects that were in DataHub a moment earlier. If
 * somebody renames a column on the hosted instance, the demo starts reporting
 * it, with nothing here redeployed.
 *
 * Two properties are kept from the fixture version, because they are what make
 * a public demo safe to leave running:
 *
 *   - **It writes nothing.** The visitor's breaking changes are applied to the
 *     snapshot this request just read, in memory, and thrown away. No visitor
 *     can damage the catalog, and two visitors cannot see each other's changes.
 *   - **It is stateless.** Nothing is stored between requests, so it still runs
 *     on a serverless host with no disk.
 *
 * What that costs: the mutations are simulated rather than written, so this
 * demonstrates detection against a live catalog, not write-back. Write-back
 * against a live catalog is what `npm run prove` does, and CI re-derives its
 * receipts on every push — see `.github/workflows/prove.yml`.
 */

import { snapshotEntity } from "./decay";
import { datahubGraphQL, gmsReachable } from "./datahub-graphql";
import { DEMO_MUTATIONS, demoRunbook } from "./demo-drift";
import { diffAgainstCatalog } from "./decay";
import { isDemoMode } from "./mcp";
import { versionOf } from "./provenance";
import type { DecayReport, EntitySnapshot, Handoff } from "./types";

/**
 * Where the demo read from, stated in the response so a reader never has to
 * guess whether a number came from a catalog or from this repository.
 */
export interface LiveReadReceipt {
  /** Host only. A token, if one is configured, never leaves the server. */
  gms: string;
  datahubVersion?: string;
  /** When the read happened — this request, not a build. */
  readAt: string;
  /** How long the catalog took to answer, so a cached response is visible. */
  readMs: number;
  /** Whether this response reused a read taken for another visitor seconds ago. */
  cached: boolean;
  entities: {
    urn: string;
    exists: boolean;
    /** The entity-level fingerprint, recomputable from the catalog's own facts. */
    version?: string;
    fields: number;
    owners: number;
  }[];
}

/* ── Availability ─────────────────────────────────────────────────────── */

let cached: { at: number; available: boolean } | null = null;
const PROBE_TTL_MS = 30_000;

/**
 * Whether this deployment can serve the live variant at all.
 *
 * `DEMO_MODE` wins: an instance explicitly put into fixture mode stays there
 * even if a GMS happens to be reachable, which is the same rule the write-back
 * guards use. Otherwise it depends on whether DataHub answers, probed at most
 * every 30 seconds so a dead catalog does not cost every visitor a timeout.
 */
export async function liveDemoAvailable(): Promise<boolean> {
  if (isDemoMode()) return false;
  if (!process.env.DATAHUB_GMS_URL) return false;
  const now = Date.now();
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.available;
  const available = await gmsReachable();
  cached = { at: now, available };
  return available;
}

function gmsHost(): string {
  const raw = process.env.DATAHUB_GMS_URL || "";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw;
  }
}

async function datahubVersion(): Promise<string | undefined> {
  const res = await datahubGraphQL<{ appConfig: { appVersion?: string } }>("{ appConfig { appVersion } }");
  return res.data?.appConfig?.appVersion ?? undefined;
}

/* ── Reading the catalog ──────────────────────────────────────────────── */

/**
 * A read is shared between visitors for a few seconds.
 *
 * Each request otherwise costs three catalog round trips, and a public URL is a
 * public URL — without this, anyone with `curl` and a loop can point the demo's
 * traffic at somebody's DataHub. Short enough that the demo is still telling you
 * about the catalog as it is now; long enough that a burst costs one read.
 *
 * The cached snapshots are never handed out directly. Callers get a deep copy,
 * because the whole mechanic here is mutating what came back.
 */
const READ_TTL_MS = Number(process.env.DEMO_LIVE_TTL_MS || 15_000);

let readCache: { at: number; readAt: string; readMs: number; snapshots: EntitySnapshot[] } | null = null;
let inFlight: Promise<EntitySnapshot[]> | null = null;

async function readCatalog(urns: string[]): Promise<{
  snapshots: EntitySnapshot[];
  readAt: string;
  readMs: number;
  cached: boolean;
}> {
  const now = Date.now();
  if (readCache && now - readCache.at < READ_TTL_MS) {
    return { snapshots: readCache.snapshots, readAt: readCache.readAt, readMs: readCache.readMs, cached: true };
  }

  // Concurrent visitors during a cold read wait on the same read rather than
  // starting one each.
  if (!inFlight) {
    const startedAt = Date.now();
    const readAt = new Date().toISOString();
    inFlight = Promise.all(urns.map((urn) => snapshotEntity(urn)))
      .then((snapshots) => {
        readCache = { at: Date.now(), readAt, readMs: Date.now() - startedAt, snapshots };
        return snapshots;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  const snapshots = await inFlight;
  return {
    snapshots,
    readAt: readCache?.readAt ?? new Date().toISOString(),
    readMs: readCache?.readMs ?? 0,
    cached: false,
  };
}

/** Test seam: drop the shared read so a case starts from a cold catalog. */
export function resetLiveDemoCache(): void {
  readCache = null;
  inFlight = null;
  cached = null;
}

/* ── The live variant ─────────────────────────────────────────────────── */

export interface LiveDemoResult {
  report: DecayReport;
  runbook: Handoff;
  applied: { id: string; detail: string }[];
  live: LiveReadReceipt;
}

/**
 * Read the catalog now, apply the visitor's changes to what came back, diff.
 *
 * The runbook's own `snapshots` are left alone: they are what the author saw
 * when they wrote it, and a record-time baseline that moved with the catalog
 * would detect nothing by construction. Only the current side is live.
 */
export async function revalidateLive(mutationIds: string[]): Promise<LiveDemoResult> {
  const runbook = demoRunbook();
  const urns = [...new Set(runbook.steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];

  const { snapshots, readAt, readMs, cached: fromCache } = await readCatalog(urns);

  // Deep copy: the visitor's changes must not reach the cache, or one visitor's
  // dropped column would show up in the next visitor's report.
  const current: Record<string, EntitySnapshot> = JSON.parse(JSON.stringify(Object.fromEntries(snapshots.map((s) => [s.urn, s])))) as Record<
    string,
    EntitySnapshot
  >;

  const applied: { id: string; detail: string }[] = [];
  for (const id of mutationIds) {
    const mutation = DEMO_MUTATIONS.find((m) => m.id === id);
    // A mutation naming an entity this catalog does not hold is skipped rather
    // than applied to nothing, so the response cannot claim a change it did not
    // make. `applied` is what the UI reports back.
    if (!mutation || !current[runbook.steps[mutation.affectsStep - 1]?.urn ?? ""]) continue;
    mutation.apply(current);
    applied.push({ id: mutation.id, detail: mutation.detail });
  }

  // Re-fingerprint after mutating, exactly as a real read does. A pin nobody can
  // recompute is not a provenance chain.
  for (const snapshot of Object.values(current)) snapshot.version = versionOf(snapshot);

  return {
    report: diffAgainstCatalog(runbook, current),
    runbook,
    applied,
    live: {
      gms: gmsHost(),
      datahubVersion: await datahubVersion(),
      readAt,
      readMs,
      /* True when this response reused a read taken seconds ago for someone else. */
      cached: fromCache,
      entities: snapshots.map((s) => ({
        urn: s.urn,
        exists: s.exists,
        version: s.version?.entity,
        fields: s.fields.length,
        owners: s.owners.length,
      })),
    },
  };
}
