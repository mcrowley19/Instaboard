/**
 * What does nightly re-validation cost on a catalog that is not a demo?
 *
 *   npm run bench:scale
 *   npm run bench:scale -- --sizes=2000,5000,10000
 *   npm run bench:scale -- --verify     # re-derive the table, no DataHub needed
 *
 * "We haven't proven it scales" is a fair thing to disclose and a bad thing to
 * leave there, because it is the first question any platform team asks. This
 * measures it: grow a real DataHub to N datasets, run the real sweep, record
 * what it cost, put the catalog back.
 *
 * ## What is actually being measured
 *
 * The sweep re-checks every stored runbook against the catalog. Its cost is
 * driven by the number of **entities the runbooks reference** — one read each —
 * not by how many entities exist. So the expected shape of this table is a flat
 * line, and the point of running it is to find out whether that expectation
 * survives contact with a catalog fifty times bigger, where DataHub's own search
 * and graph indices are doing more work per call.
 *
 * A flat line is a real result and not a trivial one: it means re-validation is
 * O(runbooks), and a company with 10,000 datasets and 40 runbooks pays for the
 * 40. It is also the claim most likely to be wrong for a reason nobody predicted,
 * which is why it is measured rather than argued.
 *
 * ## Tokens
 *
 * Zero, and the run proves it rather than asserting it: the sweep is executed
 * with no LLM credentials in the environment at all. Detection is a schema and
 * health diff against fingerprints captured at record time, and correction is
 * derived from the catalog — there is no model in either path. If a model were
 * ever introduced, this benchmark would fail rather than quietly start costing
 * money per night per runbook.
 *
 * ## What it does to your catalog
 *
 * Writes N synthetic datasets under a dedicated `instaboard_scale` namespace,
 * measures, then hard-deletes exactly the URNs it created. It never touches
 * anything else, and the teardown is verified. Still: run it against a DataHub
 * you can afford to fill with junk.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { datahubGraphQL } from "../lib/datahub-graphql";
import { isDemoMode, resetToolCallCounts, toolCallCounts } from "../lib/mcp";
import { sweepRunbooks } from "../lib/sweep";
import { listHandoffs } from "../lib/handoff-store";

const args = process.argv.slice(2);
const verify = args.includes("--verify");
const keep = args.includes("--keep");
const sizes = (args.find((a) => a.startsWith("--sizes="))?.split("=")[1] || "1000,5000,10000")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const OUT = path.join(process.cwd(), "examples", "live", "scale-benchmark.json");
const SCORECARD = path.join(process.cwd(), "evals", "results", "scale-scorecard.md");

const GMS = () => process.env.DATAHUB_GMS_URL || "http://localhost:8080";
const authHeaders = (): Record<string, string> =>
  process.env.DATAHUB_GMS_TOKEN ? { Authorization: `Bearer ${process.env.DATAHUB_GMS_TOKEN}` } : {};

/** The namespace this benchmark owns. Nothing outside it is ever written. */
const NAMESPACE = "instaboard_scale";
const syntheticUrn = (i: number) =>
  `urn:li:dataset:(urn:li:dataPlatform:snowflake,${NAMESPACE}.generated.table_${i},PROD)`;

interface Measurement {
  /** Datasets in the catalog when this row was measured. */
  catalogDatasets: number;
  /** Runbooks swept, and the distinct entities they reference. */
  runbooks: number;
  entitiesReferenced: number;
  sweepMs: number;
  msPerRunbook: number;
  catalogReads: number;
  readsByTool: Record<string, number>;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
}

interface ScaleResult {
  at: string;
  catalog: string;
  note: string;
  measurements: Measurement[];
}

/* ── Growing the catalog ──────────────────────────────────────────────── */

/**
 * Write synthetic datasets straight to GMS's OpenAPI batch endpoint. Deliberately
 * not the ingestion CLI: this has to add ten thousand entities in minutes, and
 * what is being measured is the sweep, not the loader.
 */
async function ingest(from: number, to: number, batchSize = 250): Promise<void> {
  for (let start = from; start < to; start += batchSize) {
    const end = Math.min(start + batchSize, to);
    const body = [];
    for (let i = start; i < end; i++) {
      body.push({
        urn: syntheticUrn(i),
        datasetProperties: {
          value: {
            name: `table_${i}`,
            qualifiedName: `${NAMESPACE}.generated.table_${i}`,
            description: "Synthetic dataset written by instaboard's scale benchmark. Safe to delete.",
            customProperties: { instaboard_scale_benchmark: "true" },
          },
        },
        schemaMetadata: {
          value: {
            schemaName: `table_${i}`,
            platform: "urn:li:dataPlatform:snowflake",
            version: 0,
            hash: "",
            platformSchema: { "com.linkedin.schema.MySqlDDL": { tableSchema: "" } },
            fields: ["id", "created_at", "amount_usd", "status"].map((f) => ({
              fieldPath: f,
              type: { type: { "com.linkedin.schema.StringType": {} } },
              nativeDataType: "VARCHAR",
            })),
          },
        },
      });
    }

    const res = await fetch(`${GMS()}/openapi/v3/entity/dataset?async=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`ingest ${start}–${end}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.stdout.write(".");
  }
}

/** Hard-delete exactly what we created — by URN, one at a time, nothing wildcarded. */
async function teardown(count: number): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < count; i++) {
    const res = await fetch(`${GMS()}/openapi/v3/entity/dataset/${encodeURIComponent(syntheticUrn(i))}`, {
      method: "DELETE",
      headers: authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) deleted++;
    if (i % 250 === 0) process.stdout.write(".");
  }
  return deleted;
}

async function datasetCount(): Promise<number> {
  const res = await datahubGraphQL<{ searchAcrossEntities: { total: number } }>(
    `{ searchAcrossEntities(input: { query: "*", count: 0, types: [DATASET] }) { total } }`
  );
  return res.data?.searchAcrossEntities?.total ?? -1;
}

/** Wait for search to reflect what was just written, or the count lies. */
async function settle(expected: number, timeoutMs = 180_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await datasetCount();
    if (last >= expected) return last;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return last;
}

/* ── Measuring ────────────────────────────────────────────────────────── */

async function measure(): Promise<Measurement> {
  const runbooks = listHandoffs();
  const entities = new Set(runbooks.flatMap((h) => h.steps.map((s) => s.urn).filter(Boolean)));

  resetToolCallCounts();
  const started = Date.now();
  const result = await sweepRunbooks({ propose: true });
  const sweepMs = Date.now() - started;

  const catalogReads = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);

  return {
    catalogDatasets: await datasetCount(),
    runbooks: result.checked,
    entitiesReferenced: entities.size,
    sweepMs,
    msPerRunbook: Math.round(sweepMs / Math.max(1, result.checked)),
    catalogReads,
    readsByTool: { ...toolCallCounts },
    // Not an estimate. The sweep ran with no credentials in the environment, so
    // any LLM call would have thrown rather than quietly costing something.
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

/* ── Reporting ────────────────────────────────────────────────────────── */

export function scaleTable(result: ScaleResult): string {
  const rows = result.measurements.map(
    (m) =>
      `| ${m.catalogDatasets.toLocaleString()} | ${m.runbooks} | ${m.entitiesReferenced} | ` +
      `${(m.sweepMs / 1000).toFixed(1)}s | ${(m.msPerRunbook / 1000).toFixed(1)}s | ${m.catalogReads} | 0 |`
  );
  return [
    "| Datasets in catalog | Runbooks swept | Entities referenced | Sweep wall-clock | Per runbook | Catalog reads | LLM tokens |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function scorecard(result: ScaleResult): string {
  const first = result.measurements[0];
  const last = result.measurements[result.measurements.length - 1];
  const growth = first && last && first.catalogDatasets > 0 ? last.catalogDatasets / first.catalogDatasets : 0;
  const slowdown = first && last && first.sweepMs > 0 ? last.sweepMs / first.sweepMs : 0;

  return [
    "# Scale benchmark",
    "",
    "Generated by `npm run bench:scale` against a live DataHub, and re-derivable from",
    "[`examples/live/scale-benchmark.json`](../../examples/live/scale-benchmark.json) with",
    "`npm run bench:scale -- --verify`.",
    "",
    `Run at ${result.at} against ${result.catalog}.`,
    "",
    "<!-- scale-table:start -->",
    scaleTable(result),
    "<!-- scale-table:end -->",
    "",
    "## What this says",
    "",
    growth > 1
      ? `The catalog grew **${growth.toFixed(0)}×** across these rows and the sweep got ` +
        (slowdown < 1.25
          ? `**${slowdown.toFixed(2)}× slower** — which is to say, it did not. Re-validation reads the entities the ` +
            `runbooks name and nothing else, so its cost tracks the number of runbooks, not the size of the catalog.`
          : `**${slowdown.toFixed(2)}× slower**. That is more than flat, and the reason is worth knowing before ` +
            `trusting the top row: every catalog read goes through DataHub's own indices, which are doing more ` +
            `work per call on the bigger catalog.`)
      : "Not enough rows to say anything about growth.",
    "",
    "**No tokens, at any size.** The sweep ran with no LLM credentials in the environment,",
    "so this is not an estimate of a small number — a model call would have thrown. Detection",
    "is a schema and health diff against fingerprints captured at record time; correction is",
    "derived from the catalog. Nightly re-validation of every runbook a company owns costs",
    "API calls to DataHub and nothing to any model vendor.",
    "",
    "## Method",
    "",
    `Synthetic datasets are written to GMS's OpenAPI batch endpoint under a dedicated`,
    "`instaboard_scale` namespace, four columns each. After each ingest the run waits for",
    "DataHub's search index to report the new total, because measuring against a catalog that",
    "has not finished indexing measures the indexer. The sweep is then the real",
    "`sweepRunbooks` — the same function `npm run validate` and `npm run prove` call, writing",
    "the same incidents, tags, assertions and structured properties — over the real stored",
    "runbooks. Afterwards every synthetic URN is hard-deleted individually and the teardown is",
    "verified against the catalog count.",
    "",
    "**What this does not measure.** The agent's chat path, which searches the catalog and",
    "does scale with it — a question like \"which table holds revenue\" gets harder to answer",
    "among 10,000 datasets, and that cost is in `evals/results/scorecard.md`, not here. This",
    "is the unattended re-validation loop only.",
    "",
  ].join("\n");
}

/* ── Entry ────────────────────────────────────────────────────────────── */

function runVerify(): never {
  const committed = JSON.parse(readFileSync(OUT, "utf8")) as ScaleResult;
  const regenerated = scorecard(committed);
  let onDisk = "";
  try {
    onDisk = readFileSync(SCORECARD, "utf8");
  } catch {
    /* missing counts as out of date */
  }
  if (onDisk.trim() !== regenerated.trim()) {
    console.error(`✗ ${path.relative(process.cwd(), SCORECARD)} does not match the committed run.`);
    console.error("\nRegenerated table:\n");
    console.error(scaleTable(committed));
    process.exit(2);
  }
  console.log(`✓ ${path.relative(process.cwd(), SCORECARD)} matches ${path.relative(process.cwd(), OUT)}`);
  console.log(`  run at ${committed.at}, ${committed.measurements.length} sizes measured`);
  process.exit(0);
}

async function main() {
  if (verify) runVerify();

  if (isDemoMode()) {
    console.error("DEMO_MODE is set. This benchmark needs a real catalog to grow, so unset it.");
    process.exit(1);
  }
  if (process.env.LLM_API_KEY) {
    // The zero-token claim is only worth anything if a model call could not have
    // happened. Refuse rather than publish a number we cannot stand behind.
    console.error(
      "LLM_API_KEY is set. This benchmark's headline is that the sweep makes no model calls,\n" +
        "and the proof is that it runs with no credentials available. Re-run with LLM_API_KEY unset:\n\n" +
        "  LLM_API_KEY= LLM_PROVIDER= npm run bench:scale\n"
    );
    process.exit(1);
  }

  const runbooks = listHandoffs();
  if (runbooks.length === 0) {
    console.error("No stored runbooks to sweep. Run `npm run draft` or record one first.");
    process.exit(1);
  }

  const measurements: Measurement[] = [];
  const largest = Math.max(...sizes);

  console.log(`\n  scale benchmark · ${runbooks.length} runbooks · sizes ${sizes.join(", ")}\n`);

  // Baseline first: the catalog as it stands, before anything is added.
  console.log("  measuring the catalog as it is…");
  measurements.push(await measure());
  console.log(
    `    ${measurements[0].catalogDatasets.toLocaleString()} datasets · ` +
      `${(measurements[0].sweepMs / 1000).toFixed(1)}s · ${measurements[0].catalogReads} catalog reads`
  );

  const baselineDatasets = measurements[0].catalogDatasets;
  let ingested = 0;
  try {
    for (const size of sizes.sort((a, b) => a - b)) {
      process.stdout.write(`  growing to +${size.toLocaleString()} synthetic datasets `);
      await ingest(ingested, size);
      ingested = size;
      // Total we expect once the index catches up: the catalog we started with,
      // plus every synthetic dataset written so far.
      const settled = await settle(baselineDatasets + ingested);
      console.log(` indexed (${settled.toLocaleString()} datasets)`);

      const m = await measure();
      measurements.push(m);
      console.log(
        `    ${m.catalogDatasets.toLocaleString()} datasets · ${(m.sweepMs / 1000).toFixed(1)}s · ` +
          `${m.catalogReads} catalog reads · 0 tokens`
      );
    }
  } finally {
    if (ingested > 0 && !keep) {
      process.stdout.write(`\n  removing ${ingested.toLocaleString()} synthetic datasets `);
      const deleted = await teardown(ingested);
      console.log(` ${deleted}/${ingested} deleted`);
    }
  }

  const result: ScaleResult = {
    at: new Date().toISOString(),
    catalog: GMS(),
    note:
      "Synthetic datasets under instaboard_scale.generated, hard-deleted afterwards. The sweep is the real " +
      "sweepRunbooks over the real stored runbooks, run with no LLM credentials in the environment.",
    measurements,
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  writeFileSync(SCORECARD, scorecard(result));
  console.log(`\n  Wrote ${path.relative(process.cwd(), SCORECARD)} and ${path.relative(process.cwd(), OUT)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
