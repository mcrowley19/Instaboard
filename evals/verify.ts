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
 * Both suites get verified: the Northbeam catalog this repo seeds, and the
 * official `showcase-ecommerce` datapack.
 */

type Arm = "grounded" | "schema" | "blind";

/**
 * `cells` is one (model, arm, run) pass; a multi-run scorecard has many per arm.
 * `arms` is the older single-pass shape, still read so results committed before
 * the harness grew replicates stay verifiable rather than quietly skipped.
 */
interface StoredResults {
  meta: { model: string; models?: string[]; runs?: number; mode: string; at: string };
  cells?: { model: string; arm: Arm; run: number; cases: CaseResult[] }[];
  arms?: { arm: Arm; cases: CaseResult[] }[];
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
  const passes = stored.cells ?? (stored.arms ?? []).map((a) => ({ ...a, model: stored.meta.model, run: 0 }));

  // Every pass is re-scored independently, then collected per arm. With
  // replicates the published figure is a mean over passes, so verifying one
  // representative pass would leave most of the claim unchecked.
  const perArm: Record<string, number[]> = {};

  for (const pass of passes) {
    let passed = 0;
    for (const storedCase of pass.cases) {
      const def = suite.cases.find((c) => c.id === storedCase.id);
      if (!def) {
        console.error(`✗ ${suite.name}/${pass.arm}/${storedCase.id}: no such case in the ${suite.name} suite`);
        mismatches++;
        continue;
      }
      const rescored = summarizeCase(scoreCase(def, storedCase.answer));
      if (rescored.passed !== storedCase.passed || rescored.score !== storedCase.score) {
        console.error(
          `✗ ${suite.name}/${pass.model}/${pass.arm}/run${pass.run}/${storedCase.id}: stored ` +
            `${storedCase.score}/${storedCase.maxScore} (passed=${storedCase.passed}) but re-scoring the ` +
            `committed answer gives ${rescored.score}/${rescored.maxScore} (passed=${rescored.passed})`
        );
        mismatches++;
      }
      if (rescored.passed) passed++;
    }
    (perArm[pass.arm] ??= []).push(passed);
  }

  const mean = (xs: number[] = []) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
  const show = (xs: number[] = []) => {
    const m = mean(xs);
    if (m === undefined) return "—";
    return xs.length > 1 ? `${m.toFixed(1)}/${suite.cases.length} over ${xs.length} passes` : `${m}/${suite.cases.length}`;
  };

  console.log(
    `- ${suite.name}: re-scored ${passes.length} pass(es) from committed answers. ` +
      `With DataHub: ${show(perArm.grounded)}, ` +
      `${perArm.schema ? `warehouse schema only: ${show(perArm.schema)}, ` : ""}` +
      `control: ${show(perArm.blind)} (${(stored.meta.models ?? [stored.meta.model]).join(", ")})`
  );

  // The scorecard's headline must match what the committed answers produce.
  if (existsSync(scorecardPath)) {
    const scorecard = readFileSync(scorecardPath, "utf8");
    const claim = scorecard.match(/\*\*([\d.]+)(?: ± [\d.]+)?\/(\d+)\*\*/);
    const groundedMean = mean(perArm.grounded);
    // A mean is printed to one decimal, so compare at that resolution rather
    // than exactly — anything looser would let a real drift through.
    if (claim && groundedMean !== undefined && Math.abs(Number(claim[1]) - groundedMean) > 0.05) {
      console.error(
        `✗ ${suite.resultsPrefix}scorecard.md claims ${claim[1]}/${claim[2]} but answers re-score to ` +
          `${groundedMean.toFixed(1)}/${suite.cases.length}`
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
  console.error(`${mismatches} mismatch(es). A scorecard is not reproducible from its committed answers.`);
  process.exit(1);
}
console.log(`verified ${verified} suite(s): every number is reproducible from the committed raw answers.`);
