/**
 * Render side-by-side transcripts for the eval categories that are easiest to
 * disbelieve.
 *
 *   npm run eval:transcripts
 *
 * `hallucination` and `health-trap` are the two categories where a checkbox in
 * a scorecard settles very little. The whole claim is that the agent refuses to
 * invent a table, and that it notices when the obvious recommendation has been
 * deprecated. You have to read those to believe them. So this writes out the full
 * text of both arms, along with the DataHub calls the grounded arm made, straight
 * from the committed answers in `results/*latest.json`.
 *
 * Nothing here re-runs a model: it is a pure rendering of what is already
 * committed, so the transcripts cannot drift from the scorecard.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SUITES, type Suite } from "./suites";
import type { CaseResult } from "./score";

const CATEGORIES = ["hallucination", "health-trap"] as const;

interface StoredResults {
  meta: { model: string; mode: string; at: string };
  arms: { arm: "grounded" | "blind"; cases: CaseResult[] }[];
}

const resultsDir = path.join(process.cwd(), "evals", "results");
const outDir = path.join(resultsDir, "transcripts");

function toolSummary(calls: string[]): string {
  if (calls.length === 0) return "_No DataHub calls._";
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([name, n]) => `\`${name}\`${n > 1 ? ` ×${n}` : ""}`).join(" → ");
}

function renderCase(suite: Suite, stored: StoredResults, id: string): string | null {
  const def = suite.cases.find((c) => c.id === id);
  if (!def) return null;
  const grounded = stored.arms.find((a) => a.arm === "grounded")?.cases.find((c) => c.id === id);
  const blind = stored.arms.find((a) => a.arm === "blind")?.cases.find((c) => c.id === id);
  if (!grounded && !blind) return null;

  const lines: string[] = [
    `## \`${def.id}\``,
    "",
    `**Question.** ${def.question}`,
    "",
    `**Why it matters.** ${def.stakes}`,
    "",
    "**What has to be true to pass.**",
    "",
  ];
  for (const g of def.mustInclude) lines.push(`- must say: ${g.label}`);
  for (const g of def.mustNotInclude ?? []) lines.push(`- must **not** say: ${g.label}`);
  lines.push("");

  for (const [label, result] of [
    ["With DataHub", grounded],
    ["Control (no DataHub)", blind],
  ] as const) {
    if (!result) continue;
    lines.push(
      `### ${label}: ${result.passed ? "**PASS**" : "**FAIL**"} (${result.score}/${result.maxScore})`,
      ""
    );
    if (label === "With DataHub") lines.push(`DataHub calls: ${toolSummary(result.toolCalls)}`, "");
    for (const check of result.checks.filter((c) => !c.passed)) {
      lines.push(
        `> missed: ${check.label}${check.offender ? `, found disqualifying text \`${check.offender}\`` : ""}`,
        ""
      );
    }
    if (result.error) {
      lines.push(`> provider error: ${result.error}`, "");
      continue;
    }
    lines.push("```text", (result.answer || "(empty)").trim(), "```", "");
  }

  lines.push("---", "");
  return lines.join("\n");
}

function renderSuite(suite: Suite): string | null {
  const file = path.join(resultsDir, `${suite.resultsPrefix}latest.json`);
  if (!existsSync(file)) return null;
  const stored: StoredResults = JSON.parse(readFileSync(file, "utf8"));

  const ids = suite.cases.filter((c) => (CATEGORIES as readonly string[]).includes(c.category)).map((c) => c.id);
  if (ids.length === 0) return null;

  const body = ids.map((id) => renderCase(suite, stored, id)).filter(Boolean).join("\n");
  if (!body) return null;

  return [
    `# Trap transcripts: ${suite.name} suite`,
    "",
    `_Model \`${stored.meta.model}\` · catalog: ${stored.meta.mode} · run ${stored.meta.at}_`,
    "",
    "Two categories in the benchmark are the ones a sceptical reader should not take on",
    "trust from a checkmark:",
    "",
    "- **hallucination**. The question asks about a dataset that does not exist. It fails",
    "  by inventing a confident, plausible schema for it.",
    "- **health-trap**. The obvious answer is a table the catalog knows is deprecated,",
    "  or one whose assertions are failing right now. It fails by giving a",
    "  correct-sounding recommendation that quietly costs somebody a week.",
    "",
    "Both arms' full answers are below, verbatim from the committed run. Regenerate with",
    "`npm run eval:transcripts`, which renders `results/*latest.json` and never calls a",
    "model, so these cannot drift from the scorecard.",
    "",
    "---",
    "",
    body,
  ].join("\n");
}

mkdirSync(outDir, { recursive: true });
let written = 0;
for (const suite of Object.values(SUITES)) {
  const doc = renderSuite(suite);
  if (!doc) {
    console.log(`- ${suite.name}: no committed results with trap categories, skipping`);
    continue;
  }
  const file = path.join(outDir, `${suite.name}-traps.md`);
  writeFileSync(file, doc);
  console.log(`✓ ${path.relative(process.cwd(), file)}`);
  written++;
}
if (written === 0) {
  console.error("no transcripts written; run the benchmark first");
  process.exit(1);
}
