/**
 * instaboard eval harness.
 *
 *   npm run eval                       # both arms, demo catalog (zero setup)
 *   npm run eval -- --arm=grounded
 *   npm run eval -- --live             # run against a real DataHub via MCP
 *   npm run eval -- --concurrency=1    # gentler on a rate-limited free tier
 *   npm run eval -- --fresh            # ignore the resume cache
 *   npm run eval -- --live --suite=showcase
 *                                      # the same benchmark, re-pointed at
 *                                      # DataHub's own showcase-ecommerce
 *                                      # datapack — a catalog we didn't author
 *
 * Runs the 20-case onboarding benchmark twice through the *same* agent loop:
 * once with the DataHub MCP tool set, once with the tool list emptied. The only
 * variable between arms is DataHub access, so the gap between the two scores is
 * a clean measurement of what the catalog is worth.
 *
 * Designed to complete on a FREE API tier. A full run is ~80 LLM calls, which
 * exceeds most free daily quotas in one go, so every completed case is cached to
 * `results/cache.json` and a re-run resumes where it stopped. Hitting a quota
 * wall is therefore not a lost run — it's a pause. Re-run tomorrow and it picks
 * up the remaining cases.
 *
 * Writes evals/results/scorecard.md (human-readable) and
 * evals/results/latest.json (every raw answer, for auditing a disputed check).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAgent } from "../lib/agent";
import { listDataHubTools } from "../lib/mcp";
import { CHAT_SYSTEM_PROMPT } from "../lib/prompts";
import { isQuotaExhausted } from "../lib/providers";
import type { AgentEvent, LLMConfig } from "../lib/types";
import type { EvalCase } from "./benchmark";
import { SUITES, type Suite, type SuiteName } from "./suites";
import { scoreCase, summarizeCase, type CaseResult } from "./score";

/* ── Config ───────────────────────────────────────────────────────────── */

function loadDotEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(path.join(process.cwd(), file), "utf8");
      for (const line of raw.split("\n")) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key]) continue;
        process.env[key] = rawValue.replace(/^["']|["']$/g, "");
      }
    } catch {
      /* file absent — fine */
    }
  }
}

function llmConfig(): LLMConfig {
  const provider = process.env.LLM_PROVIDER as LLMConfig["provider"];
  const apiKey = process.env.LLM_API_KEY;
  if (!provider || !apiKey) {
    console.error(
      "\n  Set LLM_PROVIDER and LLM_API_KEY in .env.local before running the eval.\n" +
        "  e.g. LLM_PROVIDER=anthropic  LLM_API_KEY=sk-ant-...\n"
    );
    process.exit(1);
  }
  return { provider, apiKey, model: process.env.LLM_MODEL || undefined };
}

/* ── Resume cache ─────────────────────────────────────────────────────── */

type Arm = "grounded" | "blind";

/**
 * What a completed case produced. Scoring is re-applied on load, so tightening a
 * check in benchmark.ts re-scores cached answers for free rather than forcing a
 * full re-run — the expensive part is the LLM call, not the string match.
 */
interface CachedRun {
  answer: string;
  toolCalls: string[];
  durationMs: number;
}

type Cache = Record<string, CachedRun>;

const CACHE_PATH = path.join(process.cwd(), "evals", "results", "cache.json");

const cacheKey = (model: string, arm: Arm, id: string) => `${model}|${arm}|${id}`;

function loadCache(fresh: boolean): Cache {
  if (fresh || !existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/* ── Runner ───────────────────────────────────────────────────────────── */

/** Thrown to unwind the run when the provider says we're out of quota. */
class QuotaExhausted extends Error {}

function scored(evalCase: EvalCase<string>, run: CachedRun, error?: string): CaseResult {
  const checks = scoreCase(evalCase, run.answer);
  return {
    id: evalCase.id,
    category: evalCase.category,
    question: evalCase.question,
    answer: run.answer,
    checks,
    ...summarizeCase(checks),
    toolCalls: run.toolCalls,
    durationMs: run.durationMs,
    ...(error ? { error } : {}),
  };
}

async function runOne(
  evalCase: EvalCase<string>,
  arm: Arm,
  config: LLMConfig,
  groundedTools: Awaited<ReturnType<typeof listDataHubTools>>,
  cache: Cache,
  model: string,
  suite: Suite
): Promise<CaseResult & { cached?: boolean }> {
  const key = cacheKey(model, arm, evalCase.id);
  const hit = cache[key];
  if (hit) return { ...scored(evalCase, hit), cached: true };

  const toolCalls: string[] = [];
  const started = Date.now();
  let answer = "";
  let error: string | undefined;

  const emit = (event: AgentEvent) => {
    if (event.type === "tool_call") toolCalls.push(event.name);
    if (event.type === "error") error = event.message;
  };

  try {
    answer = await runAgent(
      config,
      arm === "grounded" ? CHAT_SYSTEM_PROMPT : suite.blindPrompt,
      [{ role: "user", content: evalCase.question }],
      emit,
      { tools: arm === "grounded" ? groundedTools : [] }
    );
  } catch (err) {
    if (isQuotaExhausted(err)) throw new QuotaExhausted(err instanceof Error ? err.message : String(err));
    error = err instanceof Error ? err.message : String(err);
  }

  const run: CachedRun = { answer, toolCalls, durationMs: Date.now() - started };

  // Only bank a clean result — a case that errored should be retried next run.
  if (!error && answer) {
    cache[key] = run;
    saveCache(cache);
  }

  return scored(evalCase, run, error);
}

/** Small concurrency pool — keeps the full run under a couple of minutes. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

/* ── Reporting ────────────────────────────────────────────────────────── */

interface ArmSummary {
  arm: Arm;
  cases: CaseResult[];
  casesPassed: number;
  checksPassed: number;
  checksTotal: number;
  toolCalls: number;
  durationMs: number;
}

function summarizeArm(arm: Arm, cases: CaseResult[]): ArmSummary {
  return {
    arm,
    cases,
    casesPassed: cases.filter((c) => c.passed).length,
    checksPassed: cases.reduce((n, c) => n + c.score, 0),
    checksTotal: cases.reduce((n, c) => n + c.maxScore, 0),
    toolCalls: cases.reduce((n, c) => n + c.toolCalls.length, 0),
    durationMs: cases.reduce((n, c) => n + c.durationMs, 0),
  };
}

function byCategory(cases: CaseResult[], categories: string[]): Record<string, { passed: number; total: number }> {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const category of categories) {
    const inCategory = cases.filter((c) => c.category === category);
    out[category] = { passed: inCategory.filter((c) => c.passed).length, total: inCategory.length };
  }
  return out;
}

function scorecard(arms: ArmSummary[], meta: { model: string; mode: string; at: string }, suite: Suite): string {
  const grounded = arms.find((a) => a.arm === "grounded");
  const blind = arms.find((a) => a.arm === "blind");
  const total = suite.cases.length;

  const lines: string[] = [
    suite.name === "showcase"
      ? "# instaboard onboarding benchmark — official DataHub datapack"
      : "# instaboard onboarding benchmark",
    "",
    `_Generated ${meta.at} · model \`${meta.model}\` · catalog: ${meta.mode}_`,
    "",
    `${total} questions a new hire asks in week 1, scored deterministically against`,
    `${suite.catalog}. Both arms run through the identical agent loop; the only`,
    "difference is whether the DataHub MCP tools are in the tool list.",
    "",
  ];

  if (suite.name === "showcase") {
    lines.push(
      "> **Why this suite exists.** The Northbeam scorecard runs against a catalog this",
      "> repo seeds — so a high grounded score there is, fairly, partly by construction.",
      "> This suite re-points the same questions at DataHub's own published",
      "> `showcase-ecommerce` datapack: 1,065 entities across seven platforms that",
      "> nobody here designed, loaded with one CLI command anyone can run. Every",
      "> checked fact — owners, glossary definitions, retention periods, lineage edges —",
      "> came out of that pack.",
      "",
      "> It is also a **harder** catalog. It is loaded alongside Northbeam, so the agent",
      "> searches a warehouse with real collisions: two `orders` tables, six datasets",
      "> called some form of `order_details`, `customers` in four platforms.",
      ""
    );
  }

  lines.push("## Headline", "");

  if (grounded && blind) {
    lines.push(
      `| | Cases passed | Checks passed | DataHub calls |`,
      `| --- | --- | --- | --- |`,
      `| **With DataHub (MCP)** | **${grounded.casesPassed}/${total}** | ${grounded.checksPassed}/${grounded.checksTotal} | ${grounded.toolCalls} |`,
      `| Without DataHub (control) | ${blind.casesPassed}/${total} | ${blind.checksPassed}/${blind.checksTotal} | 0 |`,
      "",
      `**${grounded.casesPassed - blind.casesPassed} of ${total} onboarding questions are answerable only with the catalog.**`,
      ""
    );
  } else {
    for (const arm of arms) {
      lines.push(`- **${arm.arm}**: ${arm.casesPassed}/${total} cases, ${arm.checksPassed}/${arm.checksTotal} checks`);
    }
    lines.push("");
  }

  lines.push("## By category", "");
  lines.push(`| Category | ${arms.map((a) => (a.arm === "grounded" ? "With DataHub" : "Control")).join(" | ")} |`);
  lines.push(`| --- | ${arms.map(() => "---").join(" | ")} |`);
  const perArm = arms.map((a) => byCategory(a.cases, suite.categories));
  for (const category of suite.categories) {
    const cells = perArm.map((c) => `${c[category].passed}/${c[category].total}`);
    lines.push(`| ${category} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Case detail", "");
  for (const evalCase of suite.cases) {
    lines.push(`### \`${evalCase.id}\` — ${evalCase.question}`, "");
    lines.push(`*Why it matters:* ${evalCase.stakes}`, "");
    for (const arm of arms) {
      const result = arm.cases.find((c) => c.id === evalCase.id);
      if (!result) continue;
      const mark = result.passed ? "PASS" : "FAIL";
      const label = arm.arm === "grounded" ? "With DataHub" : "Control";
      lines.push(`- **${label}: ${mark}** (${result.score}/${result.maxScore})`);
      for (const check of result.checks.filter((c) => !c.passed)) {
        lines.push(
          `  - missed: ${check.label}${check.offender ? ` — found disqualifying text "${check.offender}"` : ""}`
        );
      }
      if (result.error) lines.push(`  - error: ${result.error}`);
    }
    lines.push("");
  }

  lines.push(
    "## Method",
    "",
    "- **Scoring is deterministic.** Every check is a case-insensitive substring match",
    "  against the agent's final answer. There is no LLM judge and no partial credit —",
    `  a case passes only if all of its checks pass. Raw answers for every case are in`,
    `  \`${suite.resultsPrefix}latest.json\` so any check can be verified by hand.`,
    "- **Both arms share one code path** (`runAgent` in `lib/agent.ts`). The control arm",
    "  is the same loop with `tools: []`.",
    "- **The control is not a strawman.** It gets a neutral, capable-assistant prompt",
    "  asking for specific tables, owners, and SQL — the counterfactual is an",
    "  off-the-shelf chatbot, not a crippled one. Both prompts are in `suites.ts`.",
    "- **Runs on a free API tier.** A full run is ~80 LLM calls, more than most free",
    "  daily quotas allow at once, so each completed case is cached and a re-run",
    "  resumes where it stopped. A score may therefore be assembled across sessions —",
    "  always on the one model named above, never mixed.",
    ...suite.reproduce,
    ""
  );

  return lines.join("\n");
}

/* ── Main ─────────────────────────────────────────────────────────────── */

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const suiteArg = (argv.find((a) => a.startsWith("--suite="))?.split("=")[1] || "northbeam") as SuiteName;
  const suite = SUITES[suiteArg];
  if (!suite) {
    console.error(`\n  Unknown suite "${suiteArg}". Available: ${Object.keys(SUITES).join(", ")}\n`);
    process.exit(1);
  }

  const live = argv.includes("--live");
  if (suite.requiresLive && !live) {
    console.error(
      `\n  The ${suite.name} suite checks facts that live only in DataHub's own datapack,\n` +
        `  so it has no demo fixture. Run it against a live catalog:\n\n` +
        `    npm run datahub:up\n` +
        `    datahub datapack load showcase-ecommerce\n` +
        `    npm run eval -- --live --suite=${suite.name}\n`
    );
    process.exit(1);
  }
  if (!live) process.env.DEMO_MODE = "true";

  const armArg = argv.find((a) => a.startsWith("--arm="))?.split("=")[1] as Arm | undefined;
  const arms: Arm[] = armArg ? [armArg] : ["grounded", "blind"];
  const concurrency = Number(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] || 2);
  const fresh = argv.includes("--fresh");

  const config = llmConfig();
  const model = config.model || `${config.provider} default`;
  const groundedTools = await listDataHubTools();
  const cache = loadCache(fresh);

  const alreadyDone = arms.reduce(
    (n, arm) => n + suite.cases.filter((c) => cache[cacheKey(model, arm, c.id)]).length,
    0
  );

  console.log(`\n  instaboard onboarding benchmark — ${suite.name} suite`);
  console.log(`  ${suite.cases.length} cases · model ${model} · ${live ? "live DataHub" : "demo catalog"}`);
  console.log(`  ${groundedTools.length} DataHub MCP tools available to the grounded arm`);
  if (alreadyDone) console.log(`  resuming — ${alreadyDone}/${suite.cases.length * arms.length} case-runs already cached`);
  console.log();

  const summaries: ArmSummary[] = [];
  let quotaHit: string | null = null;

  for (const arm of arms) {
    if (quotaHit) break;
    process.stdout.write(`  ${arm === "grounded" ? "with DataHub" : "control (no DataHub)"} `);
    let cases: (CaseResult & { cached?: boolean })[] = [];
    try {
      cases = await mapPool(suite.cases, concurrency, async (evalCase) => {
        const result = await runOne(evalCase, arm, config, groundedTools, cache, model, suite);
        process.stdout.write(result.cached ? "·" : result.passed ? "." : "x");
        return result;
      });
    } catch (err) {
      if (!(err instanceof QuotaExhausted)) throw err;
      quotaHit = err.message;
      break;
    }
    const summary = summarizeArm(arm, cases);
    summaries.push(summary);
    console.log(`  ${summary.casesPassed}/${suite.cases.length}`);
  }

  if (quotaHit) {
    const banked = Object.keys(cache).filter((k) => k.startsWith(`${model}|`)).length;
    console.error(
      `\n\n  Provider quota exhausted — stopping before spending more time on retries.\n` +
        `  ${quotaHit.slice(0, 200)}\n\n` +
        `  ${banked}/${suite.cases.length * arms.length} case-runs are banked in evals/results/cache.json.\n` +
        `  Re-run \`npm run eval\` when the quota resets and it resumes from there.\n`
    );
    process.exit(2);
  }

  const at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const meta = {
    model,
    mode: live ? (suite.name === "showcase" ? "live DataHub + showcase-ecommerce datapack" : "live DataHub") : "demo catalog (fixture)",
    at,
    suite: suite.name,
  };

  const outDir = path.join(process.cwd(), "evals", "results");
  const p = suite.resultsPrefix;
  writeFileSync(path.join(outDir, `${p}scorecard.md`), scorecard(summaries, meta, suite));
  writeFileSync(path.join(outDir, `${p}latest.json`), JSON.stringify({ meta, arms: summaries }, null, 2));

  const grounded = summaries.find((a) => a.arm === "grounded");
  const blind = summaries.find((a) => a.arm === "blind");
  if (grounded && blind) {
    console.log(
      `\n  With DataHub: ${grounded.casesPassed}/${suite.cases.length}   Without: ${blind.casesPassed}/${suite.cases.length}   ` +
        `Delta: +${grounded.casesPassed - blind.casesPassed}\n`
    );
  }
  console.log(`  Wrote evals/results/${p}scorecard.md and ${p}latest.json\n`);

  // Non-zero exit if the grounded arm regresses — usable as a CI gate.
  const threshold = Number(process.env.EVAL_MIN_PASS || 0);
  if (grounded && threshold && grounded.casesPassed < threshold) {
    console.error(`  FAIL: grounded arm scored ${grounded.casesPassed}, below EVAL_MIN_PASS=${threshold}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
