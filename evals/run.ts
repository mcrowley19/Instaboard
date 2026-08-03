/**
 * instaboard eval harness.
 *
 *   npm run eval                       # all three arms, demo catalog (zero setup)
 *   npm run eval -- --arm=grounded
 *   npm run eval -- --live             # run against a real DataHub via MCP
 *   npm run eval -- --concurrency=1    # gentler on a rate-limited free tier
 *   npm run eval -- --fresh            # ignore the resume cache
 *   npm run eval -- --live --suite=showcase
 *                                      # the same benchmark, re-pointed at
 *                                      # DataHub's own showcase-ecommerce
 *                                      # datapack, a catalog we didn't author
 *   npm run eval -- --live --runs=3 --models=a,b,c
 *                                      # the measurement, rather than one draw
 *                                      # from it: every case re-run N times on
 *                                      # each model, with the spread published
 *
 * Runs the onboarding benchmark three times through the *same* agent loop: once
 * with the DataHub MCP tool set, once with `information_schema`-equivalent
 * warehouse introspection, once with the tool list emptied. The only variable
 * between arms is what is in the tool list, so the gap between the scores is a
 * clean measurement of what the catalog is worth.
 *
 * **One run of one model is an anecdote.** `--runs` and `--models` turn the
 * headline into a distribution: the scorecard reports mean, standard deviation
 * and full range per arm, and — the number that actually decides anything —
 * whether the grounded arm's *worst* run still beat the ungrounded arm's *best*
 * one. A gap that survives that is not sampling noise.
 *
 * Designed to complete on a FREE API tier. A full three-arm run is ~120 LLM
 * calls, which exceeds most free daily quotas in one go, so every completed case
 * is cached to `results/cache.json` and a re-run resumes where it stopped.
 * Hitting a quota wall is therefore not a lost run — it's a pause. Re-run
 * tomorrow and it picks up the remaining cases.
 *
 * Writes evals/results/scorecard.md (human-readable) and
 * evals/results/latest.json (every raw answer, for auditing a disputed check).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAgent } from "../lib/agent";
import { callWarehouseTool, WAREHOUSE_TOOLS } from "../lib/warehouse-introspection";
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

type Arm = "grounded" | "schema" | "blind";
type CatalogMode = "demo" | "live";

/**
 * Three arms, one agent loop. `grounded` gets DataHub's MCP tools. `schema` gets
 * `information_schema`-equivalent introspection — real tools, no catalog — which
 * is what isolates "what DataHub buys you" from "what having tools buys you".
 * `blind` gets nothing, which is what a new hire's chatbot has today.
 */
const ARM_LABEL: Record<Arm, string> = {
  grounded: "With DataHub",
  schema: "Warehouse schema only",
  blind: "No tools (control)",
};

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

/**
 * The key has to carry everything that could change the answer, or a resumed run
 * silently mixes incompatible results. It did: the original key was
 * `model|arm|case`, so a `--live` run and a fixture run of the same suite shared
 * an entry and whichever ran first won. Catalog mode and run index are part of
 * the identity of an answer, not metadata about it.
 */
const cacheKey = (model: string, suite: SuiteName, mode: CatalogMode, arm: Arm, id: string, run: number) =>
  `${model}|${suite}|${mode}|${arm}|${id}|r${run}`;

/**
 * Entries banked under the old three-part key. They were all produced by a
 * single run of a single model, on the fixture for `northbeam` and on live
 * DataHub for `showcase` — which is what the committed scorecards say. Mapping
 * them onto the new key keeps those published numbers reproducible from cache
 * rather than stranding them behind a schema change.
 */
function migrateLegacyKeys(cache: Cache): Cache {
  const out: Cache = {};
  for (const [key, value] of Object.entries(cache)) {
    const parts = key.split("|");
    if (parts.length !== 3) {
      out[key] = value;
      continue;
    }
    const [model, arm, id] = parts;
    for (const [name, suite] of Object.entries(SUITES)) {
      if (!suite.cases.some((c) => c.id === id)) continue;
      const mode: CatalogMode = suite.requiresLive ? "live" : "demo";
      out[cacheKey(model, name as SuiteName, mode, arm as Arm, id, 0)] = value;
    }
  }
  return out;
}

function loadCache(fresh: boolean): Cache {
  if (fresh || !existsSync(CACHE_PATH)) return {};
  try {
    return migrateLegacyKeys(JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache);
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
  suite: Suite,
  mode: CatalogMode,
  run: number
): Promise<CaseResult & { cached?: boolean }> {
  const key = cacheKey(model, suite.name, mode, arm, evalCase.id, run);
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
    const system =
      arm === "grounded" ? CHAT_SYSTEM_PROMPT : arm === "schema" ? suite.schemaPrompt : suite.blindPrompt;
    answer = await runAgent(config, system, [{ role: "user", content: evalCase.question }], emit, {
      tools: arm === "grounded" ? groundedTools : arm === "schema" ? WAREHOUSE_TOOLS : [],
      ...(arm === "schema" ? { execute: callWarehouseTool } : {}),
    });
  } catch (err) {
    if (isQuotaExhausted(err)) throw new QuotaExhausted(err instanceof Error ? err.message : String(err));
    error = err instanceof Error ? err.message : String(err);
  }

  const result: CachedRun = { answer, toolCalls, durationMs: Date.now() - started };

  // Only bank a clean result — a case that errored should be retried next time.
  if (!error && answer) {
    cache[key] = result;
    saveCache(cache);
  }

  return scored(evalCase, result, error);
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

/**
 * One (model, arm, run) triple: a complete pass over the suite by one model, in
 * one arm, once. The unit of the whole report — everything published is an
 * aggregate over cells, never a single one dressed up as the result.
 */
interface Cell {
  model: string;
  arm: Arm;
  run: number;
  cases: CaseResult[];
  casesPassed: number;
  checksPassed: number;
  checksTotal: number;
  toolCalls: number;
  durationMs: number;
}

function summarizeCell(model: string, arm: Arm, run: number, cases: CaseResult[]): Cell {
  return {
    model,
    arm,
    run,
    cases,
    casesPassed: cases.filter((c) => c.passed).length,
    checksPassed: cases.reduce((n, c) => n + c.score, 0),
    checksTotal: cases.reduce((n, c) => n + c.maxScore, 0),
    toolCalls: cases.reduce((n, c) => n + c.toolCalls.length, 0),
    durationMs: cases.reduce((n, c) => n + c.durationMs, 0),
  };
}

interface Stats {
  n: number;
  mean: number;
  /** Sample standard deviation. 0 when there is only one observation. */
  sd: number;
  min: number;
  max: number;
}

function stats(values: number[]): Stats {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0, min: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, min: Math.min(...values), max: Math.max(...values) };
}

/**
 * With one observation there is no spread to report, and printing `19.0 ± 0.0`
 * would dress a single draw up as a measurement. Print exactly what was
 * measured: an integer when n=1, a mean and a spread when there is one.
 */
function fmtStat(s: Stats, total: number): string {
  if (s.n <= 1) return `${s.mean}/${total}`;
  return `${s.mean.toFixed(1)} ± ${s.sd.toFixed(1)}/${total}`;
}

function fmtRange(s: Stats): string {
  if (s.n <= 1) return "—";
  return s.min === s.max ? `${s.min} every run` : `${s.min}–${s.max}`;
}

const cellsFor = (cells: Cell[], arm: Arm, model?: string) =>
  cells.filter((c) => c.arm === arm && (model === undefined || c.model === model));

const armStats = (cells: Cell[], arm: Arm, model?: string) =>
  stats(cellsFor(cells, arm, model).map((c) => c.casesPassed));

/** How many of an arm's cells passed a given case. The per-case stability unit. */
function caseTally(cells: Cell[], arm: Arm, id: string, model?: string): { passed: number; of: number } {
  const relevant = cellsFor(cells, arm, model);
  let passed = 0;
  let of = 0;
  for (const cell of relevant) {
    const result = cell.cases.find((c) => c.id === id);
    if (!result) continue;
    of++;
    if (result.passed) passed++;
  }
  return { passed, of };
}

/* ── Reporting ────────────────────────────────────────────────────────── */

function byCategory(cells: Cell[], arm: Arm, suite: Suite): Record<string, { passed: number; total: number }> {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const category of suite.categories) {
    const inCategory = suite.cases.filter((c) => c.category === category);
    let passed = 0;
    let total = 0;
    for (const evalCase of inCategory) {
      const tally = caseTally(cells, arm, evalCase.id);
      passed += tally.passed;
      total += tally.of;
    }
    out[category] = { passed, total };
  }
  return out;
}

/** `2/3` reads as a fraction of runs; with one run per case, plain `1/1` noise. */
function fmtCategory(cell: { passed: number; total: number }, cases: number, replicates: number): string {
  if (replicates <= 1) return `${cell.passed}/${cases}`;
  return `${(cell.passed / Math.max(replicates, 1)).toFixed(1)}/${cases}`;
}

interface ReportMeta {
  models: string[];
  runs: number;
  mode: string;
  at: string;
}

function scorecard(cells: Cell[], meta: ReportMeta, suite: Suite): string {
  const total = suite.cases.length;
  const replicates = meta.models.length * meta.runs;
  const grounded = armStats(cells, "grounded");
  const schema = armStats(cells, "schema");
  const blind = armStats(cells, "blind");
  const arms = (["grounded", "schema", "blind"] as Arm[]).filter((a) => cellsFor(cells, a).length > 0);

  const lines: string[] = [
    suite.name === "showcase"
      ? "# instaboard onboarding benchmark on the official DataHub datapack"
      : suite.name === "holdout"
        ? "# instaboard onboarding benchmark on held-out questions"
        : "# instaboard onboarding benchmark",
    "",
    `_Generated ${meta.at} · catalog: ${meta.mode}_`,
    meta.models.length === 1
      ? `_model \`${meta.models[0]}\` · ${meta.runs} run${meta.runs === 1 ? "" : "s"} per case_`
      : `_${meta.models.length} models × ${meta.runs} runs per case = ${replicates} independent passes over each arm_`,
    "",
    `${total} questions a new hire asks in week 1, scored deterministically against`,
    `${suite.catalog}. Every arm runs through the identical agent loop; the only`,
    "difference is what is in the tool list.",
    "",
  ];

  if (meta.models.length > 1) {
    lines.push(
      "> **Models**",
      "",
      ...meta.models.map((m) => `> - \`${m}\``),
      "",
    );
  }

  if (suite.name === "showcase") {
    lines.push(
      "> **Why this suite exists.** The Northbeam scorecard runs against a catalog this",
      "> repo seeds, so a high grounded score there is, fairly, partly built in.",
      "> This suite re-points the same questions at DataHub's own published",
      "> `showcase-ecommerce` datapack: 1,065 entities across seven platforms that",
      "> nobody here designed, loaded with one CLI command anyone can run. Every",
      "> checked fact came out of that pack: owners, glossary definitions, retention",
      "> periods, lineage edges.",
      "",
      "> It is also a **harder** catalog. It is loaded alongside Northbeam, so the agent",
      "> searches a warehouse with real collisions: two `orders` tables, six datasets",
      "> called some form of `order_details`, `customers` in four platforms.",
      ""
    );
  }

  lines.push("## Headline", "");

  // A "range" column over a single pass is a column of em-dashes claiming to be
  // a measurement. It appears only once there is a spread to put in it.
  const showRange = replicates > 1;

  const armRow = (arm: Arm, label: string, sees: string, s: Stats, bold: boolean) => {
    const checks = stats(cellsFor(cells, arm).map((c) => c.checksPassed));
    const checkTotal = cellsFor(cells, arm)[0]?.checksTotal ?? 0;
    const calls = stats(cellsFor(cells, arm).map((c) => c.toolCalls));
    const score = bold ? `**${fmtStat(s, total)}**` : fmtStat(s, total);
    return (
      `| ${bold ? `**${label}**` : label} | ${sees} | ${score} |` +
      `${showRange ? ` ${fmtRange(s)} |` : ""}` +
      ` ${checks.n <= 1 ? `${checks.mean}/${checkTotal}` : `${checks.mean.toFixed(1)}/${checkTotal}`} |` +
      ` ${calls.n <= 1 ? calls.mean : calls.mean.toFixed(0)} |`
    );
  };

  if (grounded.n && blind.n) {
    lines.push(
      `| Arm | What it can see | Cases passed |${showRange ? " Range |" : ""} Checks passed | Tool calls |`,
      `| --- | --- | --- |${showRange ? " --- |" : ""} --- | --- |`,
      armRow(
        "grounded",
        "With DataHub (MCP)",
        "the catalog: owners, glossary, health, deprecation, usage, lineage, saved queries",
        grounded,
        true
      )
    );
    if (schema.n) {
      lines.push(
        armRow(
          "schema",
          "Warehouse schema only",
          "table names, column names, column types — `information_schema`",
          schema,
          false
        )
      );
    }
    lines.push(
      armRow("blind", "No tools (control)", "nothing; answers from model knowledge", blind, false),
      ""
    );

    const delta = grounded.mean - blind.mean;
    lines.push(
      replicates > 1
        ? `**${delta.toFixed(1)} of ${total} onboarding questions, on average, are answerable only with the catalog.**`
        : `**${delta} of ${total} onboarding questions are answerable only with the catalog.**`,
      ""
    );

    if (schema.n) {
      const schemaDelta = grounded.mean - schema.mean;
      const schemaCalls = stats(cellsFor(cells, "schema").map((c) => c.toolCalls));
      const groundedCalls = stats(cellsFor(cells, "grounded").map((c) => c.toolCalls));
      lines.push(
        `The middle arm is the one that makes this readable. It has real tools and makes real ` +
          `lookups against the same warehouse — it just cannot see anything the catalog adds on top of ` +
          `the schema. It scores **${fmtStat(schema, total)}**, putting ` +
          `**${replicates > 1 ? schemaDelta.toFixed(1) : schemaDelta} of ${total}** questions beyond the ` +
          `reach of a database connection alone. That gap is the metadata, not the tooling.`,
        "",
        schemaCalls.mean > groundedCalls.mean
          ? `It is not that it tried less hard: it made ${schemaCalls.mean.toFixed(0)} tool calls per pass to ` +
            `the grounded arm's ${groundedCalls.mean.toFixed(0)}, and still finished ` +
            `${replicates > 1 ? schemaDelta.toFixed(1) : schemaDelta} cases behind. Listing every table in ` +
            `the warehouse does not tell you which of six identically-named copies is the one people use, ` +
            `who to ask about it, or what the company means by "active user".`
          : `It made ${schemaCalls.mean.toFixed(0)} tool calls per pass doing it — the lookups happened; the ` +
            `answers were not in the schema.`,
        ""
      );
    }
  }

  /* ── Variance ───────────────────────────────────────────────────────── */

  if (replicates > 1) {
    lines.push("## Is the gap bigger than the noise?", "");

    // The decision-relevant question is not whether two means differ. It is
    // whether the distributions overlap at all — a gap that survives worst-case
    // grounded against best-case ungrounded is not a sampling artifact.
    const contrasts: [string, Stats][] = [];
    if (schema.n) contrasts.push(["warehouse schema only", schema]);
    if (blind.n) contrasts.push(["no tools", blind]);

    for (const [label, other] of contrasts) {
      const separated = grounded.min > other.max;
      lines.push(
        separated
          ? `- **Separated from the ${label} arm.** The grounded arm's *worst* pass scored ` +
            `${grounded.min}/${total}; the ${label} arm's *best* scored ${other.max}/${total}. ` +
            `Across all ${replicates} passes the two ranges never touch, so the gap is not a draw ` +
            `from an overlapping distribution.`
          : `- **Overlaps the ${label} arm.** Grounded ranged ${grounded.min}–${grounded.max}/${total}, ` +
            `${label} ranged ${other.min}–${other.max}/${total}. The ranges intersect, so on this ` +
            `evidence the arms are not cleanly separated and the mean difference of ` +
            `${(grounded.mean - other.mean).toFixed(1)} should be read with that in mind.`
      );
    }
    lines.push("");

    lines.push(`| Arm | ${meta.models.map((m) => `\`${m.split("/").pop()}\``).join(" | ")} |`);
    lines.push(`| --- | ${meta.models.map(() => "---").join(" | ")} |`);
    for (const arm of arms) {
      const cellsByModel = meta.models.map((m) => fmtStat(armStats(cells, arm, m), total));
      lines.push(`| ${ARM_LABEL[arm]} | ${cellsByModel.join(" | ")} |`);
    }
    lines.push(
      "",
      "Per model, so a result that only holds on one of them is visible as one.",
      ""
    );

    /* Which individual cases were unstable. */
    const unstable: string[] = [];
    for (const evalCase of suite.cases) {
      for (const arm of arms) {
        const tally = caseTally(cells, arm, evalCase.id);
        if (tally.passed > 0 && tally.passed < tally.of) {
          unstable.push(`| \`${evalCase.id}\` | ${ARM_LABEL[arm]} | ${tally.passed}/${tally.of} |`);
        }
      }
    }
    const combos = suite.cases.length * arms.length;
    lines.push(
      "### Cases that did not land the same way every time",
      "",
      unstable.length === 0
        ? `None. All ${combos} (case × arm) combinations were unanimous across ${replicates} passes.`
        : `${unstable.length} of ${combos} (case × arm) combinations split. Everything else was unanimous.`,
      ""
    );
    if (unstable.length) {
      lines.push("| Case | Arm | Passes |", "| --- | --- | --- |", ...unstable, "");
    }
  }

  /* ── By category ────────────────────────────────────────────────────── */

  lines.push("## By category", "");
  if (replicates > 1) lines.push(`_Mean cases passed per pass, over ${replicates} passes._`, "");
  lines.push(`| Category | ${arms.map((a) => ARM_LABEL[a]).join(" | ")} |`);
  lines.push(`| --- | ${arms.map(() => "---").join(" | ")} |`);
  const perArm = arms.map((a) => byCategory(cells, a, suite));
  for (const category of suite.categories) {
    const inCategory = suite.cases.filter((c) => c.category === category).length;
    const row = perArm.map((c) => fmtCategory(c[category], inCategory, replicates));
    lines.push(`| ${category} | ${row.join(" | ")} |`);
  }
  lines.push("");

  /* ── Case detail ────────────────────────────────────────────────────── */

  lines.push("## Case detail", "");
  for (const evalCase of suite.cases) {
    lines.push(`### \`${evalCase.id}\` — ${evalCase.question}`, "");
    lines.push(`*Why it matters:* ${evalCase.stakes}`, "");
    for (const arm of arms) {
      const tally = caseTally(cells, arm, evalCase.id);
      if (tally.of === 0) continue;
      const mark = tally.passed === tally.of ? "PASS" : tally.passed === 0 ? "FAIL" : "MIXED";
      const only = tally.of === 1 ? cellsFor(cells, arm)[0]?.cases.find((c) => c.id === evalCase.id) : undefined;
      const suffix = only ? ` (${only.score}/${only.maxScore})` : ` ${tally.passed}/${tally.of} passes`;
      lines.push(`- **${ARM_LABEL[arm]}: ${mark}**${suffix}`);

      // Report the misses from a failing pass — with replicates, listing every
      // pass's misses buries the reason under repetition of it.
      const failing = cellsFor(cells, arm)
        .map((c) => c.cases.find((x) => x.id === evalCase.id))
        .find((r) => r && !r.passed);
      if (failing) {
        for (const check of failing.checks.filter((c) => !c.passed)) {
          lines.push(
            `  - missed: ${check.label}${check.offender ? ` — found disqualifying text "${check.offender}"` : ""}`
          );
        }
        if (failing.error) lines.push(`  - error: ${failing.error}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "## Method",
    "",
    "- **Scoring is deterministic.** Every check is a case-insensitive substring match",
    "  against the agent's final answer. There is no LLM judge and no partial credit —",
    `  a case passes only if all of its checks pass. Raw answers for every pass are in`,
    `  \`${suite.resultsPrefix}latest.json\` so any check can be verified by hand.`,
    "- **All three arms share one code path** (`runAgent` in `lib/agent.ts`). The control",
    "  arm is the same loop with `tools: []`; the schema arm is the same loop pointed at",
    "  `lib/warehouse-introspection.ts` instead of the MCP server.",
    "- **Neither control is a strawman.** The no-tools arm gets a neutral,",
    "  capable-assistant prompt asking for specific tables, owners and SQL — the",
    "  counterfactual is an off-the-shelf chatbot, not a crippled one. The schema arm is",
    "  told to look everything up and never guess at a name it has not seen. All three",
    "  prompts are in `suites.ts`.",
    "- **The schema arm reads the same catalog**, stripped to what a warehouse connection",
    "  would return: table names, column names, column types. Sourcing it separately would",
    "  make its lower score an artifact of the harness rather than a finding about",
    "  metadata.",
    ...(replicates > 1
      ? [
          `- **${replicates} passes per arm, not one.** Every case was answered afresh` +
            ` ${meta.runs} time${meta.runs === 1 ? "" : "s"} on each of ${meta.models.length} models` +
            ` — ${replicates * suite.cases.length * arms.length} agent runs in total. Means, standard`,
          "  deviations and full ranges are computed over those passes; nothing here is a single",
          "  draw. Answers are cached per (model, catalog, arm, case, run), so no pass is ever",
          "  reused as another.",
        ]
      : [
          "- **Runs on a free API tier.** A full run is ~120 LLM calls across three arms, more",
          "  than most free daily quotas allow at once, so each completed case is cached and a",
          "  re-run resumes where it stopped. A score may therefore be assembled across",
          "  sessions — always on the one model named above, never mixed.",
        ]),
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
  const arms: Arm[] = armArg ? [armArg] : ["grounded", "schema", "blind"];
  const concurrency = Number(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] || 2);
  const fresh = argv.includes("--fresh");
  const runs = Math.max(1, Number(argv.find((a) => a.startsWith("--runs="))?.split("=")[1] || 1));

  const config = llmConfig();
  const mode: CatalogMode = live ? "live" : "demo";

  // `--models` runs the whole design once per model. A result that only holds on
  // the model it was developed against is a property of that model, and the only
  // way to see which one you have is to vary it.
  const models = (argv.find((a) => a.startsWith("--models="))?.split("=")[1] || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) models.push(config.model || `${config.provider} default`);

  const groundedTools = await listDataHubTools();
  const cache = loadCache(fresh);

  const planned = models.length * arms.length * runs * suite.cases.length;
  const alreadyDone = models.reduce(
    (n, model) =>
      n +
      arms.reduce(
        (m, arm) =>
          m +
          Array.from({ length: runs }, (_, run) =>
            suite.cases.filter((c) => cache[cacheKey(model, suite.name, mode, arm, c.id, run)]).length
          ).reduce((a, b) => a + b, 0),
        0
      ),
    0
  );

  console.log(`\n  instaboard onboarding benchmark, ${suite.name} suite`);
  console.log(
    `  ${suite.cases.length} cases · ${models.length} model${models.length === 1 ? "" : "s"} · ` +
      `${runs} run${runs === 1 ? "" : "s"} per case · ${live ? "live DataHub" : "demo catalog"}`
  );
  console.log(`  ${groundedTools.length} DataHub MCP tools available to the grounded arm`);
  console.log(`  ${planned} agent runs planned${alreadyDone ? `, ${alreadyDone} already cached` : ""}`);
  console.log();

  const cells: Cell[] = [];
  let quotaHit: string | null = null;

  outer: for (const model of models) {
    if (models.length > 1) console.log(`  ${model}`);
    for (const arm of arms) {
      for (let run = 0; run < runs; run++) {
        const label = `${ARM_LABEL[arm].toLowerCase()}${runs > 1 ? ` run ${run + 1}` : ""}`;
        process.stdout.write(`  ${label.padEnd(28)} `);
        let cases: (CaseResult & { cached?: boolean })[] = [];
        try {
          cases = await mapPool(suite.cases, concurrency, async (evalCase) => {
            const result = await runOne(evalCase, arm, { ...config, model }, groundedTools, cache, model, suite, mode, run);
            process.stdout.write(result.cached ? "\u00b7" : result.passed ? "." : "x");
            return result;
          });
        } catch (err) {
          if (!(err instanceof QuotaExhausted)) throw err;
          quotaHit = err.message;
          break outer;
        }
        const cell = summarizeCell(model, arm, run, cases);
        cells.push(cell);
        console.log(`  ${cell.casesPassed}/${suite.cases.length}`);
      }
    }
  }

  if (quotaHit) {
    console.error(
      `\n\n  Provider quota exhausted \u2014 stopping before spending more time on retries.\n` +
        `  ${quotaHit.slice(0, 200)}\n\n` +
        `  ${Object.keys(cache).length}/${planned} case-runs are banked in evals/results/cache.json.\n` +
        `  Re-run \`npm run eval\` when the quota resets and it resumes from there.\n`
    );
    process.exit(2);
  }

  const at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const meta = {
    models,
    // Kept for readers and tools that expect a single name; with several models
    // it is a summary, and `models` is the authoritative list.
    model: models.length === 1 ? models[0] : `${models.length} models`,
    runs,
    mode: live
      ? suite.name === "northbeam"
        ? "live DataHub"
        : "live DataHub + showcase-ecommerce datapack"
      : "demo catalog (fixture)",
    at,
    suite: suite.name,
  };

  const outDir = path.join(process.cwd(), "evals", "results");
  const p = suite.resultsPrefix;
  writeFileSync(path.join(outDir, `${p}scorecard.md`), scorecard(cells, meta, suite));
  writeFileSync(path.join(outDir, `${p}latest.json`), JSON.stringify({ meta, cells }, null, 2));

  const grounded = armStats(cells, "grounded");
  const blind = armStats(cells, "blind");
  if (grounded.n && blind.n) {
    console.log(
      `\n  With DataHub: ${fmtStat(grounded, suite.cases.length)}   ` +
        `Without: ${fmtStat(blind, suite.cases.length)}   ` +
        `Delta: +${(grounded.mean - blind.mean).toFixed(1)}`
    );
    if (grounded.n > 1) {
      console.log(
        `  Grounded range ${grounded.min}\u2013${grounded.max}, control range ${blind.min}\u2013${blind.max}` +
          `${grounded.min > blind.max ? " (no overlap)" : " (ranges overlap)"}`
      );
    }
    console.log();
  }
  console.log(`  Wrote evals/results/${p}scorecard.md and ${p}latest.json\n`);

  // Non-zero exit if the grounded arm regresses \u2014 usable as a CI gate. With
  // replicates the floor is the worst pass, not the average: a threshold that
  // only the mean clears is a threshold the tool does not actually meet.
  const threshold = Number(process.env.EVAL_MIN_PASS || 0);
  if (grounded.n && threshold && grounded.min < threshold) {
    console.error(`  FAIL: grounded arm's worst pass scored ${grounded.min}, below EVAL_MIN_PASS=${threshold}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
