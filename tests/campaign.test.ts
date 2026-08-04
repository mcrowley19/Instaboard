import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRepoPatch, discoverRepos, listRepoFiles, verifyPatch, type CampaignEdit } from "@/lib/campaign";

/**
 * The campaign's whole claim is that its patches merge. That is checkable with
 * nothing but this repo: the committed patches under `examples/campaigns/` are
 * re-derived from the committed repair receipts and the committed consumer
 * repos, byte for byte, and then applied to pristine copies with git. A patch
 * that drifted from either input fails here, offline, on every push.
 */

const CONSUMER_ROOT = path.join(process.cwd(), "examples", "consumer");
const CAMPAIGN_ROOT = path.join(process.cwd(), "examples", "campaigns");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface Manifest {
  catalog: string;
  generatedFrom: string;
  urn: string;
  edits: CampaignEdit[];
  planHash: string;
  repos: {
    repo: string;
    files: { file: string; replacements: number; hashBefore: string; hashAfter: string }[];
    patchHash: string;
    applyCheck: { passed: boolean; detail: string };
  }[];
  evidence: { source: string; detail: string };
}

const CATALOGS = ["northbeam", "showcase"].filter((c) =>
  existsSync(path.join(CAMPAIGN_ROOT, c, "campaign.json"))
);

it("has a committed campaign for at least the seeded catalog", () => {
  expect(CATALOGS).toContain("northbeam");
});

describe.each(CATALOGS.map((c) => [c] as [string]))("the committed campaign on %s", (catalog) => {
  const dir = path.join(CAMPAIGN_ROOT, catalog);
  const manifest = JSON.parse(readFileSync(path.join(dir, "campaign.json"), "utf8")) as Manifest;

  it("rides the approval from the repair receipts, plan hash and all", () => {
    const receipts = JSON.parse(readFileSync(path.join(process.cwd(), manifest.generatedFrom), "utf8")) as {
      approval: { planHash: string; applied: CampaignEdit[] };
      breakingChanges: { urn: string }[];
    };
    expect(manifest.planHash).toBe(receipts.approval.planHash);
    expect(manifest.urn).toBe(receipts.breakingChanges[0].urn);
    expect(manifest.edits).toEqual(receipts.approval.applied.filter((e) => e.kind === "column-rename"));
  });

  it("spans more than one repo, and one of them is a dbt project", () => {
    expect(manifest.repos.length).toBeGreaterThanOrEqual(2);
    const dbt = manifest.repos.find((r) => r.repo.endsWith("-dbt"));
    expect(dbt).toBeDefined();
    expect(existsSync(path.join(CONSUMER_ROOT, dbt!.repo, "dbt_project.yml"))).toBe(true);
  });

  it("patches the dbt model SQL and the sources.yml that documents the column", () => {
    const dbt = manifest.repos.find((r) => r.repo.endsWith("-dbt"))!;
    const touched = dbt.files.map((f) => f.file);
    expect(touched.some((f) => f.endsWith(".sql"))).toBe(true);
    expect(touched.some((f) => f.endsWith("sources.yml"))).toBe(true);
  });

  it("re-derives every patch byte-for-byte from the committed receipts and repos", () => {
    for (const repo of discoverRepos(CONSUMER_ROOT, catalog)) {
      const fresh = buildRepoPatch(CONSUMER_ROOT, repo, manifest.edits);
      const committed = manifest.repos.find((r) => r.repo === repo);
      if (!committed) {
        expect(fresh.files, `${repo} affected but missing from the manifest`).toHaveLength(0);
        continue;
      }
      expect(fresh.patchHash, repo).toBe(committed.patchHash);
      expect(fresh.files, repo).toEqual(committed.files);
    }
  });

  it("commits the patch files it hashes", () => {
    for (const repo of manifest.repos) {
      const patch = readFileSync(path.join(dir, `${repo.repo}.patch`), "utf8");
      expect(sha256(patch), repo.repo).toBe(repo.patchHash);
    }
  });

  it("applies every committed patch to a pristine copy, files hashing as promised", () => {
    for (const repo of manifest.repos) {
      const patch = readFileSync(path.join(dir, `${repo.repo}.patch`), "utf8");
      const result = verifyPatch(path.join(CONSUMER_ROOT, repo.repo), patch, repo.files);
      expect(result.passed, `${repo.repo}: ${result.detail}`).toBe(true);
      expect(repo.applyCheck.passed, repo.repo).toBe(true);
    }
  });

  it("lists every file in every repo that reads the old column, and no others", () => {
    for (const repoName of discoverRepos(CONSUMER_ROOT, catalog)) {
      const listed = new Set(manifest.repos.find((r) => r.repo === repoName)?.files.map((f) => f.file) ?? []);
      for (const file of listRepoFiles(path.join(CONSUMER_ROOT, repoName))) {
        const content = readFileSync(path.join(CONSUMER_ROOT, repoName, file), "utf8");
        const reads = manifest.edits.some((e) =>
          new RegExp(`\\b${e.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content)
        );
        expect(listed.has(file), `${repoName}/${file}`).toBe(reads);
      }
    }
  });

  it("says where its blast-radius evidence came from", () => {
    expect(["live", "unavailable"]).toContain(manifest.evidence.source);
    expect(manifest.evidence.detail.length).toBeGreaterThan(0);
  });
});
