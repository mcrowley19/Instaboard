/**
 * Hide everything the held-out suite was not written against, and put it back.
 *
 *   npx tsx scripts/isolate-catalog.ts --only=holdout   # hide the rest
 *   npx tsx scripts/isolate-catalog.ts --restore        # undo, exactly
 *   npx tsx scripts/isolate-catalog.ts --status         # what is hidden now
 *
 * ## Why this exists
 *
 * The held-out questions were authored from a dump of `showcase-ecommerce` and
 * nothing else. Run against a DataHub that also holds this repo's Northbeam
 * catalog, the agent answers them from Northbeam — "there is no dataset named
 * `order_details`" — and the score measures the name collision rather than the
 * catalog. That is not a hypothetical: it is what happened on the first attempt,
 * and it is written up in `evals/holdout/README.md`.
 *
 * There is no flag for it. Northbeam seeds `snowflake` and `postgres`, and
 * showcase uses both, so no platform filter, domain or DataHub View separates
 * them for an agent that searches the whole catalog. The separation has to be
 * per-URN.
 *
 * ## What it does, and what it does not
 *
 * It **soft** deletes, through the same mutation DataHub's own UI uses. The
 * entity drops out of search, and every aspect it owns stays exactly where it
 * was: schema, owners, tags, assertions, the lot. Restoring is the same call
 * with the flag flipped. Nothing is destroyed, which is the only reason this is
 * a reasonable thing to run against a catalog somebody is using.
 *
 * The set of URNs it hid is written to a manifest first, so `--restore` puts back
 * precisely what this tool took away and cannot resurrect something that was
 * already soft-deleted for its own reasons.
 *
 * ## Read this before running it
 *
 * The hosted write-back demo reads three Northbeam datasets. While the catalog is
 * isolated, that demo has no catalog: it will report the runbook's entities as
 * missing. A holdout run and a live demo cannot share one DataHub, and this makes
 * the tradeoff explicit rather than surprising.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { datahubGraphQL } from "../lib/datahub-graphql";

const args = process.argv.slice(2);
const mode = args.includes("--restore")
  ? "restore"
  : args.includes("--status")
    ? "status"
    : args.find((a) => a.startsWith("--only="))
      ? "isolate"
      : null;

const MANIFEST = path.join(process.cwd(), "data", "isolation-manifest.json");
const DUMP = path.join(process.cwd(), "evals", "holdout", "catalog-dump.json");

interface Manifest {
  at: string;
  reason: string;
  /** URNs this tool soft-deleted, and must be the only ones it restores. */
  hidden: string[];
}

/**
 * The datasets the held-out questions were written from, read out of the very
 * dump the author model was shown. Deriving the keep-list from anything else —
 * a platform, a name prefix, a hand-maintained list — would let the two drift
 * apart, and the whole point of the suite is that the questions and the catalog
 * correspond.
 */
function keepSet(): Set<string> {
  const raw = readFileSync(DUMP, "utf8");
  return new Set(raw.match(/urn:li:dataset:\([^)]*\)/g) ?? []);
}

async function allDatasetUrns(): Promise<string[]> {
  const res = await datahubGraphQL<{
    searchAcrossEntities: { searchResults: { entity: { urn: string } }[] };
  }>(`{ searchAcrossEntities(input: { query: "*", count: 1000, types: [DATASET] }) { searchResults { entity { urn } } } }`);
  return (res.data?.searchAcrossEntities?.searchResults ?? []).map((r) => r.entity.urn);
}

/**
 * Soft delete / undelete through DataHub's own mutation.
 *
 * Not by writing the `status` aspect directly, which was the obvious thing to
 * try and does not work: the aspect lands — `status { removed: true }` reads
 * back — and the entity stays in the search index anyway, so an agent searching
 * the catalog still finds it. Hiding something from `get_entities` but not from
 * `search` would be the worst of both, because the contamination this exists to
 * prevent arrives through search.
 *
 * `batchUpdateSoftDeleted` is the path DataHub's own UI uses, and it updates the
 * index along with the aspect.
 */
async function setRemoved(urns: string[], removed: boolean): Promise<number> {
  const res = await datahubGraphQL<{ batchUpdateSoftDeleted: boolean }>(
    `mutation softDelete($input: BatchUpdateSoftDeletedInput!) { batchUpdateSoftDeleted(input: $input) }`,
    { input: { urns, deleted: removed } }
  );
  if (res.errors?.length) {
    console.error(`  ${res.errors[0].message}`);
    return 0;
  }
  return res.data?.batchUpdateSoftDeleted ? urns.length : 0;
}

/**
 * One URN per call, despite the mutation taking a list.
 *
 * A single-URN call returns in ~84ms; a 24-URN call did not return inside 20s.
 * Whatever the batch path does per entity, it is not what the singular path
 * does, and a batch that times out loses the whole batch — including the record
 * of which of its members had already been applied. Sequential and slightly
 * slower is the right trade for something whose failure mode is a catalog left
 * half-hidden.
 */
async function setRemovedAll(urns: string[], removed: boolean): Promise<number> {
  let done = 0;
  for (const urn of urns) {
    done += await setRemoved([urn], removed);
    process.stdout.write(".");
  }
  return done;
}

async function isolate(): Promise<void> {
  if (existsSync(MANIFEST)) {
    console.error(
      `\n  ${path.relative(process.cwd(), MANIFEST)} already exists — the catalog is already isolated.\n` +
        `  Run --restore first, or delete the manifest if you know it is stale.\n`
    );
    process.exit(1);
  }

  const keep = keepSet();
  const all = await allDatasetUrns();
  const hide = all.filter((u) => !keep.has(u));

  console.log(`\n  ${all.length} datasets visible · ${keep.size} in the holdout's dump · hiding ${hide.length}\n`);
  if (hide.length === 0) {
    console.log("  Nothing to hide — the catalog already holds only what the suite expects.\n");
    return;
  }

  // Manifest first. A crash between the writes and the record would leave
  // datasets hidden with nothing that knows to put them back.
  mkdirSync(path.dirname(MANIFEST), { recursive: true });
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      { at: new Date().toISOString(), reason: "holdout suite requires a showcase-only catalog", hidden: hide },
      null,
      2
    )
  );

  const done = await setRemovedAll(hide, true);
  console.log(`\n  soft-deleted ${done}/${hide.length}. Manifest: ${path.relative(process.cwd(), MANIFEST)}`);
  console.log(`  The hosted write-back demo has no catalog until you run --restore.\n`);
}

async function restore(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    console.error(`\n  No manifest at ${path.relative(process.cwd(), MANIFEST)} — nothing this tool hid.\n`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  console.log(`\n  restoring ${manifest.hidden.length} datasets hidden at ${manifest.at}\n`);

  const done = await setRemovedAll(manifest.hidden, false);

  if (done === manifest.hidden.length) {
    writeFileSync(MANIFEST + ".done", readFileSync(MANIFEST));
    // Only drop the manifest once every URN is back, so a partial restore stays
    // repeatable instead of losing the record of what is still hidden.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(MANIFEST);
    console.log(`\n  restored ${done}/${manifest.hidden.length}. Catalog is whole again.\n`);
  } else {
    console.error(
      `\n  restored ${done}/${manifest.hidden.length} — manifest kept so this can be re-run.\n`
    );
    process.exit(1);
  }
}

async function status(): Promise<void> {
  const keep = keepSet();
  const all = await allDatasetUrns();
  const extra = all.filter((u) => !keep.has(u));
  const isolated = existsSync(MANIFEST);
  console.log(`\n  manifest: ${isolated ? "present — catalog is isolated" : "absent"}`);
  console.log(`  visible datasets: ${all.length}`);
  console.log(`  in the holdout dump: ${keep.size}`);
  console.log(`  visible but not in the dump: ${extra.length}${extra.length ? ` (holdout would see these)` : ""}\n`);
  for (const u of extra.slice(0, 8)) console.log(`    ${u.split(",")[1]}`);
  if (extra.length > 8) console.log(`    …and ${extra.length - 8} more`);
  console.log();
}

async function main() {
  if (!mode) {
    console.error(
      "\n  usage:\n" +
        "    --only=holdout   hide every dataset the holdout's dump does not contain\n" +
        "    --restore        put back exactly what was hidden\n" +
        "    --status         report what the holdout would currently see\n"
    );
    process.exit(1);
  }
  if (mode === "isolate") await isolate();
  else if (mode === "restore") await restore();
  else await status();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
