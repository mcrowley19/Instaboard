/**
 * Does a fresh run of the loop still produce the receipts this repo committed?
 *
 *   npm run prove                        # regenerates examples/live/prove-loop-receipts.json
 *   npm run prove:verify                 # ...and this says whether it came out the same
 *
 * `tests/prove-receipts.test.ts` checks that the receipts on disk say what the
 * README says they say. That is a necessary check and an insufficient one: it
 * passes just as happily on an artifact nobody has regenerated in a month. This
 * script is the other half. It compares the file `npm run prove` just wrote
 * against the copy committed at HEAD, and fails if a re-run of the same loop
 * against a real DataHub produced a different result.
 *
 * Together they close the loop CI could not close before: the live job in
 * `.github/workflows/prove.yml` re-derives the artifact rather than re-reading
 * it, and a receipt that has drifted from what the code actually does now fails
 * the build instead of sitting in the repo looking authoritative.
 *
 * What is allowed to differ between two runs, and nothing else:
 *
 *   - when the run happened (`startedAt`, `finishedAt`)
 *   - where DataHub was (`gms`)
 *   - server-minted identifiers: document, incident and assertion URNs are
 *     freshly generated or content-hashed per run, so they are masked to their
 *     shape. That a document *exists* is compared; its UUID is not.
 *   - timestamps embedded anywhere in a string
 *
 * Everything else — every check and its detail line, every breaking change,
 * every verdict, coverage figure, claim count, tag read-back, incident
 * assignee, proposed edit — has to come out identical. If the catalog, the
 * runbook or the detector changed on purpose, re-run `npm run prove` and commit
 * what it produced. That commit is the record of the change.
 *
 * Flags:
 *   --catalog=<name>    northbeam (default) or showcase
 *   --repair            verify the prove:repair receipts instead of the loop's
 *   --baseline=<path>   compare against a file instead of the copy at HEAD
 *   --baseline=git      the copy at HEAD (default)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const catalog = args.find((a) => a.startsWith("--catalog="))?.split("=")[1] ?? "northbeam";
const baselineArg = args.find((a) => a.startsWith("--baseline="))?.split("=")[1] ?? "git";
const repair = args.includes("--repair");

const stem = repair ? "prove-repair-receipts" : "prove-loop-receipts";
const RELATIVE = path.join("examples", "live", catalog === "northbeam" ? `${stem}.json` : `${stem}-${catalog}.json`);

/* ── What a re-run is allowed to change ───────────────────────────────── */

/**
 * Dropped wholesale: when the run happened, which server it talked to, and who
 * ran it. The repair receipts record the operator as the drill's approver, and
 * "michael" on a laptop has to agree with "runner" on CI.
 */
const VOLATILE_KEYS = new Set(["startedAt", "finishedAt", "gms", "approvedBy"]);

/**
 * Identifiers minted per run. The shape is asserted, the value is not — a
 * document URN proves a document was written, and its UUID proves nothing.
 */
const MASKS: [RegExp, string][] = [
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g, "<timestamp>"],
  // Bare dates too. Structured property values carry a human-readable
  // "(checked 2026-08-02)", so without this the build fails every time the day
  // rolls over, which trains everyone to ignore it.
  [/\b\d{4}-\d{2}-\d{2}\b/g, "<date>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/urn:li:assertion:instaboard-[0-9a-f]+/g, "urn:li:assertion:instaboard-<hash>"],
];

/** The tags this tool applies. Everything else on a dataset belongs to someone else. */
const OWN_TAGS = ["urn:li:tag:StaleRunbook", "urn:li:tag:UnvalidatedRunbookStep"];

function mask(value: string): string {
  return MASKS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value);
}

/**
 * `tagReadBack` records every tag DataHub returned on a dataset, which is the
 * right thing to record and the wrong thing to compare verbatim. Whether some
 * other tag exists on `mrr_monthly` is a fact about the catalog the run happened
 * to use, not about whether the loop still works, and DataHub does not promise
 * an order either. What has to reproduce is our own tags: on while the runbook
 * is broken, off once it is repaired. That is what gets compared.
 */
function normalize(value: unknown): unknown {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = normalize(inner);
    }
    return out;
  }
  return value;
}

/**
 * `tagReadBack` is `{ tagsWhileBroken: { <datasetUrn>: [tagUrn, …] }, … }`, so
 * the rewrite has to reach two levels down rather than ride along on the generic
 * walk.
 */
function normalizeReceipts(receipts: unknown): unknown {
  const out = normalize(receipts) as Record<string, unknown>;

  /*
   * The first check records how DataHub came to be there — "GMS answering at
   * …" on a machine where it was already up, "started via `datahub docker
   * quickstart`" on a runner that had to boot it. Both mean DataHub is up,
   * which is what the check asserts and what has to reproduce. Comparing the
   * sentence instead compares the environment, and would make it impossible for
   * a CI run and a laptop run to ever agree.
   */
  const checks = out.checks as { phase?: string; what?: string; detail?: string }[] | undefined;
  for (const check of checks ?? []) {
    if (check.phase === "datahub" && check.what === "DataHub is up") check.detail = "<how DataHub got here>";
  }

  // The loop's receipts carry tag read-backs under `tagReadBack`; the repair's
  // carry them inside `writeback`. Same facts, same filtering.
  const writeback = out.writeback as Record<string, unknown> | undefined;
  const readBacks = [
    out.tagReadBack as Record<string, Record<string, unknown>> | undefined,
    writeback && {
      tagsWhileBroken: writeback.tagsWhileBroken as Record<string, unknown>,
      tagsAfterRepair: writeback.tagsAfterRepair as Record<string, unknown>,
    },
  ];

  for (const readBack of readBacks) {
    if (!readBack) continue;
    for (const phase of Object.keys(readBack)) {
      const byDataset = readBack[phase];
      if (!byDataset || typeof byDataset !== "object") continue;
      for (const datasetUrn of Object.keys(byDataset)) {
        const urns = byDataset[datasetUrn];
        if (!Array.isArray(urns)) continue;
        byDataset[datasetUrn] = urns
          .filter((urn): urn is string => typeof urn === "string" && OWN_TAGS.includes(urn))
          .sort();
      }
    }
  }
  return out;
}

/* ── Diffing ──────────────────────────────────────────────────────────── */

interface Difference {
  path: string;
  committed: unknown;
  fresh: unknown;
}

function render(value: unknown): string {
  if (value === undefined) return "(absent)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** Walks both trees together so a difference is reported where it happened. */
function diff(committed: unknown, fresh: unknown, at = ""): Difference[] {
  if (JSON.stringify(committed) === JSON.stringify(fresh)) return [];

  const bothArrays = Array.isArray(committed) && Array.isArray(fresh);
  const bothObjects =
    !bothArrays &&
    committed !== null &&
    fresh !== null &&
    typeof committed === "object" &&
    typeof fresh === "object";

  if (bothArrays) {
    const out: Difference[] = [];
    if (committed.length !== fresh.length) {
      out.push({ path: `${at}.length`, committed: committed.length, fresh: fresh.length });
    }
    for (let i = 0; i < Math.max(committed.length, fresh.length); i++) {
      out.push(...diff(committed[i], fresh[i], `${at}[${i}]`));
    }
    return out;
  }

  if (bothObjects) {
    const keys = new Set([
      ...Object.keys(committed as Record<string, unknown>),
      ...Object.keys(fresh as Record<string, unknown>),
    ]);
    return [...keys].flatMap((key) =>
      diff(
        (committed as Record<string, unknown>)[key],
        (fresh as Record<string, unknown>)[key],
        at ? `${at}.${key}` : key,
      ),
    );
  }

  return [{ path: at || "(root)", committed, fresh }];
}

/* ── Run ──────────────────────────────────────────────────────────────── */

function readBaseline(): unknown {
  if (baselineArg !== "git") return JSON.parse(readFileSync(path.resolve(baselineArg), "utf8"));
  try {
    // The receipts on disk have just been overwritten by the run under test, so
    // the committed copy has to come out of git rather than off the filesystem.
    const raw = execFileSync("git", ["show", `HEAD:${RELATIVE}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Could not read ${RELATIVE} at HEAD: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Pass --baseline=<path> to compare against a file instead.");
    process.exit(2);
  }
}

const freshPath = path.join(process.cwd(), RELATIVE);
let fresh: unknown;
try {
  fresh = JSON.parse(readFileSync(freshPath, "utf8"));
} catch (err) {
  console.error(`No receipts to verify at ${RELATIVE}: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`Run \`npm run prove${repair ? ":repair" : ""} -- --catalog=${catalog}\` first.`);
  process.exit(2);
}

const differences = diff(normalizeReceipts(readBaseline()), normalizeReceipts(fresh));

const freshSummary = (fresh as { summary?: { passed?: number; total?: number } }).summary;
const passed = freshSummary?.passed ?? 0;
const total = freshSummary?.total ?? 0;

if (differences.length === 0) {
  console.log(`✓ ${RELATIVE} — a fresh run against a live DataHub reproduced the committed receipts exactly.`);
  console.log(`  ${passed}/${total} checks passed, and every check, verdict and coverage figure matched.`);
  process.exit(0);
}

console.error(`✗ ${RELATIVE} — a fresh run did not reproduce the committed receipts.`);
console.error(`  ${differences.length} difference(s). The committed artifact is stale, or something changed:\n`);
for (const difference of differences.slice(0, 40)) {
  console.error(`  ${difference.path}`);
  console.error(`    committed: ${render(difference.committed)}`);
  console.error(`    fresh:     ${render(difference.fresh)}`);
}
if (differences.length > 40) console.error(`  …and ${differences.length - 40} more.`);
console.error(
  `\n  If the change is intended, commit the receipts this run produced —` +
    ` that commit is the record of it. If it is not, the loop has regressed.`,
);
process.exit(1);
