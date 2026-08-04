/**
 * A repair campaign: one approved correction, fanned out across every consumer
 * repo that reads the broken column, as patches a maintainer can actually
 * merge.
 *
 * The single-workspace drill (`npm run prove:repair`) proves the correction
 * executes. This module answers the next question a data platform team asks:
 * *who else is broken, and what do we send them?* It walks every repo under
 * `examples/consumer/` that belongs to the catalog — plain SQL directories and
 * dbt projects alike — applies the approved rename to a scratch copy, emits a
 * git-format unified diff per repo, and then verifies each patch with
 * `git apply --check` against a pristine copy. "Mergeable" is a result the
 * receipt carries, never an adjective.
 *
 * The blast radius is grounded in the catalog where the catalog can answer:
 * the saved queries DataHub holds on the broken dataset, and its downstream
 * lineage. When no live catalog is reachable the campaign still builds — the
 * patches are a pure function of the repos and the approved edits — and the
 * evidence block says `unavailable` rather than pretending.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { callDataHubTool } from "./mcp";
import { unifiedDiff } from "./remediate";

/** The slice of an approved edit a campaign needs, as the repair receipts carry it. */
export interface CampaignEdit {
  kind: string;
  from: string;
  to: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** File types a rename can land in: SQL itself, and the YAML that documents it. */
const PATCHABLE = new Set([".sql", ".yml", ".yaml"]);

/* ── Repos ────────────────────────────────────────────────────────────── */

/**
 * A "repo" is a directory under the consumer root belonging to the catalog:
 * the catalog's own name, or `<catalog>-<anything>` — `northbeam` and
 * `northbeam-dbt` are two repos in the northbeam campaign.
 */
export function discoverRepos(consumerRoot: string, catalog: string): string[] {
  return readdirSync(consumerRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === catalog || e.name.startsWith(`${catalog}-`)))
    .map((e) => e.name)
    .sort();
}

/** Every patchable file in the repo, relative paths, stable order. */
export function listRepoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (PATCHABLE.has(path.extname(entry.name))) out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

/* ── Building and verifying one repo's patch ──────────────────────────── */

export interface PatchedFile {
  file: string;
  replacements: number;
  hashBefore: string;
  hashAfter: string;
}

export interface RepoPatch {
  repo: string;
  /** Only files the rename actually landed in. */
  files: PatchedFile[];
  /** git-format unified diff over every touched file, `git apply -p1`-able. */
  patch: string;
  patchHash: string;
  /** The verification, run for real: `git apply --check` on a pristine copy. */
  applyCheck: { passed: boolean; detail: string };
}

/**
 * Apply the approved column renames to every patchable file, in memory, and
 * return the per-file substitutions. Whole words only, same rule as the
 * single-workspace repair.
 */
function applyEdits(content: string, edits: CampaignEdit[]): { after: string; replacements: number } {
  let after = content;
  let replacements = 0;
  for (const edit of edits.filter((e) => e.kind === "column-rename")) {
    after = after.replace(new RegExp(`\\b${escapeRegExp(edit.from)}\\b`, "g"), () => {
      replacements++;
      return edit.to;
    });
  }
  return { after, replacements };
}

export function buildRepoPatch(consumerRoot: string, repo: string, edits: CampaignEdit[]): RepoPatch {
  const root = path.join(consumerRoot, repo);
  const files: PatchedFile[] = [];
  const diffs: string[] = [];

  for (const file of listRepoFiles(root)) {
    const before = readFileSync(path.join(root, file), "utf8");
    const { after, replacements } = applyEdits(before, edits);
    if (after === before) continue;
    files.push({ file, replacements, hashBefore: sha256(before), hashAfter: sha256(after) });
    // `unifiedDiff` splits on "\n", so a newline-terminated file grows a
    // phantom empty final line; on a short file it lands inside the hunk and
    // git rejects the patch. Diff the content without its final newline — for
    // git, no marker means the trailing newline is implied.
    diffs.push(unifiedDiff(`a/${file}`, `b/${file}`, chompFinalNewline(before), chompFinalNewline(after)));
  }

  const patch = diffs.join("");
  return {
    repo,
    files,
    patch,
    patchHash: sha256(patch),
    applyCheck: files.length ? verifyPatch(root, patch, files) : { passed: false, detail: "nothing to patch" },
  };
}

const chompFinalNewline = (s: string) => (s.endsWith("\n") ? s.slice(0, -1) : s);

/**
 * The mergeability proof. The patch is applied — not just checked — to a
 * pristine copy of the repo with plain `git apply`, and the resulting files
 * must hash to exactly what the campaign said they would.
 */
export function verifyPatch(
  repoRoot: string,
  patch: string,
  expected: PatchedFile[]
): { passed: boolean; detail: string } {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "instaboard-campaign-"));
  try {
    for (const file of listRepoFiles(repoRoot)) {
      const dest = path.join(scratch, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(repoRoot, file), dest);
    }
    const patchFile = path.join(scratch, ".campaign.patch");
    writeFileSync(patchFile, patch);
    try {
      execFileSync("git", ["apply", "--check", "-p1", patchFile], { cwd: scratch, stdio: "pipe" });
      execFileSync("git", ["apply", "-p1", patchFile], { cwd: scratch, stdio: "pipe" });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
      return { passed: false, detail: `git apply failed: ${stderr || String(err)}` };
    }
    for (const { file, hashAfter } of expected) {
      const got = sha256(readFileSync(path.join(scratch, file), "utf8"));
      if (got !== hashAfter) {
        return { passed: false, detail: `${file} hashed ${got.slice(0, 12)} after apply, expected ${hashAfter.slice(0, 12)}` };
      }
    }
    return {
      passed: true,
      detail: "git apply --check passed, the patch applied to a pristine copy, and every patched file hashed as promised",
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ── Catalog evidence for the blast radius ────────────────────────────── */

export interface CampaignEvidence {
  source: "live" | "unavailable";
  /** Saved queries DataHub holds on the dataset that mention the old column. */
  savedQueriesMatched: { name?: string; excerpt: string }[];
  savedQueriesChecked: number;
  /** Datasets downstream of the broken one, from catalog lineage. */
  downstream: string[];
  detail: string;
}

const collectValues = (value: unknown, key: string): unknown[] => {
  const out: unknown[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        if (k === key) out.push(inner);
        else walk(inner);
      }
    }
  };
  walk(value);
  return out;
};

const collectStrings = (value: unknown, key: string): string[] =>
  collectValues(value, key).filter((v): v is string => typeof v === "string");

/** A statement comes back as a string or as `{value, language}`, server-dependent. */
const asSql = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" ? String((v as Record<string, unknown>).value ?? "") : "";

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Ask the catalog who else touches this column: the saved queries on the
 * dataset, matched for the old name the same word-boundary way the detector
 * matches, and one hop of downstream lineage. Both calls mirror the shapes
 * `lib/draft-runbook.ts` already handles.
 */
export async function gatherEvidence(urn: string, from: string): Promise<CampaignEvidence> {
  try {
    const savedQueriesMatched: { name?: string; excerpt: string }[] = [];
    let savedQueriesChecked = 0;

    const queries = await callDataHubTool("get_dataset_queries", { urn });
    if (!queries.isError) {
      const parsed = parseJson(queries.content);
      const statements = [
        ...collectValues(parsed, "statement"),
        ...collectValues(parsed, "sql"),
        ...collectValues(parsed, "query"),
      ]
        .map(asSql)
        .filter((s) => s.trim().length >= 20);
      const names = collectStrings(parsed, "name");
      const word = new RegExp(`\\b${escapeRegExp(from)}\\b`);
      savedQueriesChecked = statements.length;
      statements.forEach((sql, i) => {
        if (!word.test(sql)) return;
        const line = sql.split("\n").find((l) => word.test(l))?.trim() ?? sql.slice(0, 80);
        savedQueriesMatched.push({ ...(names[i] ? { name: names[i] } : {}), excerpt: line.slice(0, 160) });
      });
    }

    let lineage = await callDataHubTool("get_lineage", { urn, upstream: false, max_hops: 1 });
    if (lineage.isError) {
      lineage = await callDataHubTool("get_lineage", { urn, direction: "downstream", max_hops: 1 });
    }
    const downstream = lineage.isError
      ? []
      : [...new Set(collectStrings(parseJson(lineage.content), "urn"))].filter(
          (u) => u.startsWith("urn:li:dataset:") && u !== urn
        );

    return {
      source: "live",
      savedQueriesMatched,
      savedQueriesChecked,
      downstream: downstream.slice(0, 12),
      detail:
        `${savedQueriesMatched.length}/${savedQueriesChecked} saved queries on the dataset mention the old column; ` +
        `${downstream.length} downstream dataset(s) one hop away.`,
    };
  } catch (err) {
    return {
      source: "unavailable",
      savedQueriesMatched: [],
      savedQueriesChecked: 0,
      downstream: [],
      detail: `No live catalog to ask: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
