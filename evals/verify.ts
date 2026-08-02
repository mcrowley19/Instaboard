import { readFileSync } from "node:fs";
import path from "node:path";
import { BENCHMARK } from "./benchmark";
import { scoreCase, summarizeCase, type CaseResult } from "./score";

/**
 * Re-verify the committed benchmark results without an LLM.
 *
 * Scoring is a pure function of (case definition, answer text), and every raw
 * answer is committed in results/latest.json. So CI can re-run the scorer over
 * the stored answers on every push and fail if the numbers in the scorecard
 * could not have been produced by this code from these answers. A green badge
 * therefore means: the published 19/20 vs 5/20 is reproducible from committed
 * artifacts, not just claimed.
 */

interface StoredResults {
  meta: { model: string; mode: string; at: string };
  arms: { arm: "grounded" | "blind"; cases: CaseResult[] }[];
}

const resultsPath = path.join(process.cwd(), "evals", "results", "latest.json");
const stored: StoredResults = JSON.parse(readFileSync(resultsPath, "utf8"));

let mismatches = 0;
const headline: Record<string, { passed: number; total: number }> = {};

for (const arm of stored.arms) {
  let passed = 0;
  for (const storedCase of arm.cases) {
    const def = BENCHMARK.find((c) => c.id === storedCase.id);
    if (!def) {
      console.error(`✗ ${arm.arm}/${storedCase.id}: no such case in benchmark.ts`);
      mismatches++;
      continue;
    }
    const rescored = summarizeCase(scoreCase(def, storedCase.answer));
    if (rescored.passed !== storedCase.passed || rescored.score !== storedCase.score) {
      console.error(
        `✗ ${arm.arm}/${storedCase.id}: stored ${storedCase.score}/${storedCase.maxScore} ` +
          `(passed=${storedCase.passed}) but re-scoring the committed answer gives ` +
          `${rescored.score}/${rescored.maxScore} (passed=${rescored.passed})`
      );
      mismatches++;
    }
    if (rescored.passed) passed++;
  }
  headline[arm.arm] = { passed, total: arm.cases.length };
}

const grounded = headline.grounded;
const blind = headline.blind;
console.log(
  `re-scored from committed answers — with DataHub: ${grounded?.passed}/${grounded?.total}, ` +
    `control: ${blind?.passed}/${blind?.total} (model ${stored.meta.model})`
);

// The scorecard's headline must match what the committed answers produce.
const scorecard = readFileSync(path.join(process.cwd(), "evals", "results", "scorecard.md"), "utf8");
const claim = scorecard.match(/\*\*(\d+)\/(\d+)\*\*/);
if (claim && grounded && Number(claim[1]) !== grounded.passed) {
  console.error(`✗ scorecard.md claims ${claim[1]}/${claim[2]} but answers re-score to ${grounded.passed}/${grounded.total}`);
  mismatches++;
}

if (mismatches > 0) {
  console.error(`${mismatches} mismatch(es) — scorecard is not reproducible from committed answers.`);
  process.exit(1);
}
console.log("scorecard verified: every number is reproducible from the committed raw answers.");
