/**
 * Fan the approved correction out to every consumer repo, as mergeable patches.
 *
 *   npm run campaign            # both catalogs, wherever repair receipts exist
 *   npm run campaign -- --json  # machine-readable summary
 *
 * The input is the committed output of `npm run prove:repair`: the approved
 * edit set, its plan hash, and the broken dataset's URN, straight from
 * `examples/live/prove-repair-receipts*.json`. So a campaign only ever ships
 * edits that carry an approval, and CI can re-derive every patch offline from
 * artifacts already in the repo — the patches are a pure function of the
 * receipts and the consumer repos.
 *
 * For each catalog the script walks every repo under `examples/consumer/`
 * that belongs to it (the plain SQL workspace and the dbt project), applies
 * the rename to each, emits one git-format patch per repo, and verifies each
 * patch by applying it to a pristine copy. Where a live DataHub is reachable
 * the campaign also records the catalog's case for the blast radius: which
 * saved queries on the dataset mention the old column, and what sits one hop
 * downstream. Patches never depend on that evidence, so the offline rerun
 * produces byte-identical diffs.
 *
 * Exits non-zero if any patch fails its apply check, or if a receipt names a
 * rename no repo is affected by — a campaign that patches nothing is a claim
 * with no subject.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gmsReachable } from "../lib/datahub-graphql";
import { isDemoMode } from "../lib/mcp";
import {
  buildRepoPatch,
  discoverRepos,
  gatherEvidence,
  type CampaignEdit,
  type CampaignEvidence,
  type RepoPatch,
} from "../lib/campaign";

const args = process.argv.slice(2);
const json = args.includes("--json");

const CONSUMER_ROOT = path.join(process.cwd(), "examples", "consumer");
const OUT_ROOT = path.join(process.cwd(), "examples", "campaigns");

const say = (message: string): void => {
  if (!json) console.log(message);
};

interface RepairReceipts {
  catalogProfile: string;
  breakingChanges: { kind: string; urn: string }[];
  approval: { planHash: string; applied: CampaignEdit[] } | null;
}

interface CampaignManifest {
  catalog: string;
  generatedFrom: string;
  urn: string;
  edits: CampaignEdit[];
  /** The plan hash from the repair receipts — the approval these patches ride on. */
  planHash: string;
  repos: Omit<RepoPatch, "patch">[];
  evidence: CampaignEvidence;
  at: string;
}

async function campaignFor(catalog: string, receiptsFile: string): Promise<{ ok: boolean; manifest: CampaignManifest }> {
  const receipts = JSON.parse(readFileSync(receiptsFile, "utf8")) as RepairReceipts;
  const urn = receipts.breakingChanges[0]?.urn;
  const edits = (receipts.approval?.applied ?? []).filter((e) => e.kind === "column-rename");
  if (!urn || !receipts.approval || edits.length === 0) {
    throw new Error(`${receiptsFile} carries no approved column rename to campaign on.`);
  }

  say(`\n${catalog}: ${edits.map((e) => `${e.from} → ${e.to}`).join(", ")} (plan ${receipts.approval.planHash.slice(0, 16)})`);

  const repos = discoverRepos(CONSUMER_ROOT, catalog);
  const patches = repos.map((repo) => buildRepoPatch(CONSUMER_ROOT, repo, edits)).filter((p) => p.files.length > 0);

  // Patches never depend on the catalog; the evidence names who else is in the
  // blast radius when there is a catalog to ask. Never let the fixture answer.
  const evidence: CampaignEvidence =
    !isDemoMode() && (await gmsReachable())
      ? await gatherEvidence(urn, edits[0].from)
      : {
          source: "unavailable",
          savedQueriesMatched: [],
          savedQueriesChecked: 0,
          downstream: [],
          detail: "No live catalog was reachable when this campaign was generated.",
        };

  const outDir = path.join(OUT_ROOT, catalog);
  mkdirSync(outDir, { recursive: true });
  for (const patch of patches) {
    writeFileSync(path.join(outDir, `${patch.repo}.patch`), patch.patch);
  }

  const manifest: CampaignManifest = {
    catalog,
    generatedFrom: path.relative(process.cwd(), receiptsFile),
    urn,
    edits,
    planHash: receipts.approval.planHash,
    repos: patches.map(({ patch: _patch, ...rest }) => rest),
    evidence,
    at: new Date().toISOString(),
  };
  writeFileSync(path.join(outDir, "campaign.json"), JSON.stringify(manifest, null, 2) + "\n");

  for (const p of patches) {
    say(
      `  ${p.applyCheck.passed ? "✓" : "✗"} ${p.repo}: ${p.files.length} file(s), ` +
        `${p.files.reduce((n, f) => n + f.replacements, 0)} replacement(s), patch ${p.patchHash.slice(0, 12)} — ` +
        p.applyCheck.detail
    );
  }
  say(`  · ${evidence.detail}`);

  const ok = patches.length >= 2 && patches.every((p) => p.applyCheck.passed);
  return { ok, manifest };
}

async function main() {
  const targets = [
    { catalog: "northbeam", receipts: path.join("examples", "live", "prove-repair-receipts.json") },
    { catalog: "showcase", receipts: path.join("examples", "live", "prove-repair-receipts-showcase.json") },
  ].filter((t) => existsSync(t.receipts));

  if (targets.length === 0) {
    console.error("No repair receipts found. Run `npm run prove:repair` first.");
    process.exit(2);
  }

  const results = [];
  for (const target of targets) {
    results.push(await campaignFor(target.catalog, target.receipts));
  }

  const failed = results.filter((r) => !r.ok);
  if (json) {
    console.log(
      JSON.stringify(
        results.map((r) => ({
          catalog: r.manifest.catalog,
          repos: r.manifest.repos.map((p) => ({ repo: p.repo, patchHash: p.patchHash, applyCheck: p.applyCheck })),
          evidence: r.manifest.evidence.source,
        })),
        null,
        2
      )
    );
  } else {
    console.log(
      `\n${results.length - failed.length}/${results.length} campaign(s) fully mergeable. ` +
        `Artifacts in ${path.relative(process.cwd(), OUT_ROOT)}/.`
    );
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
