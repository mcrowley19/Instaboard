import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SUITES, type Suite } from "./suites";
import { scoreCase, summarizeCase, type CaseResult } from "./score";

/**
 * Re-verify the committed benchmark results without an LLM.
 *
 * Scoring is a pure function of (case definition, answer text), and every raw
 * answer is committed in results/*latest.json. So CI can re-run the scorer over
 * the stored answers on every push and fail if the numbers in a scorecard could
 * not have been produced by this code from these answers. A green badge
 * therefore means: the published scores are reproducible from committed
 * artifacts, not just claimed.
 *
 * Both suites are verified — the Northbeam catalog this repo seeds, and the
 * official `showcase-ecommerce` datapack.
 */

interface StoredResults {
  meta: { model: string; mode: string; at: string };
  arms: { arm: "grounded" | "blind"; cases: CaseResult[] }[];
}

const resultsDir = path.join(process.cwd(), "evals", "results");
let mismatches = 0;
let verified = 0;

function verifySuite(suite: Suite): void {
  const answersPath = path.join(resultsDir, `${suite.resultsPrefix}latest.json`);
  const scorecardPath = path.join(resultsDir, `${suite.resultsPrefix}scorecard.md`);
  if (!existsSync(answersPath)) {
    console.log(`- ${suite.name}: no committed results, skipping`);
    return;
  }
  verified++;

  const stored: StoredResults = JSON.parse(readFileSync(answersPath, "utf8"));
  const headline: Record<string, { passed: number; total: number }> = {};

  for (const arm of stored.arms) {
    let passed = 0;
    for (const storedCase of arm.cases) {
      const def = suite.cases.find((c) => c.id === storedCase.id);
      if (!def) {
        console.error(`✗ ${suite.name}/${arm.arm}/${storedCase.id}: no such case in the ${suite.name} suite`);
        mismatches++;
        continue;
      }
      const rescored = summarizeCase(scoreCase(def, storedCase.answer));
      if (rescored.passed !== storedCase.passed || rescored.score !== storedCase.score) {
        console.error(
          `✗ ${suite.name}/${arm.arm}/${storedCase.id}: stored ${storedCase.score}/${storedCase.maxScore} ` +
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
    `- ${suite.name}: re-scored from committed answers — with DataHub: ${grounded?.passed}/${grounded?.total}, ` +
      `control: ${blind?.passed}/${blind?.total} (model ${stored.meta.model})`
  );

  // The scorecard's headline must match what the committed answers produce.
  if (existsSync(scorecardPath)) {
    const scorecard = readFileSync(scorecardPath, "utf8");
    const claim = scorecard.match(/\*\*(\d+)\/(\d+)\*\*/);
    if (claim && grounded && Number(claim[1]) !== grounded.passed) {
      console.error(
        `✗ ${suite.resultsPrefix}scorecard.md claims ${claim[1]}/${claim[2]} but answers re-score to ${grounded.passed}/${grounded.total}`
      );
      mismatches++;
    }
  }
}

for (const suite of Object.values(SUITES)) verifySuite(suite);

if (verified === 0) {
  console.error("no committed results found to verify");
  process.exit(1);
}
if (mismatches > 0) {
  console.error(`${mismatches} mismatch(es) — a scorecard is not reproducible from its committed answers.`);
  process.exit(1);
}
console.log(`verified ${verified} suite(s): every number is reproducible from the committed raw answers.`);
