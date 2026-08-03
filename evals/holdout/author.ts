/**
 * Have the held-out benchmark written by something that is not us.
 *
 *   npx tsx evals/holdout/author.ts                       # write cases.json
 *   npx tsx evals/holdout/author.ts --validate-only       # re-check the frozen file
 *
 * The strongest argument in this repo is the ablation: the same agent loop
 * scores 19/20 with the catalog and 5/20 without it. The fair objection is that
 * we wrote the questions. A benchmark whose author knows the system is a
 * benchmark the system was fitted to, however carefully it was written.
 *
 * So this suite is not ours. The catalog is DataHub's published
 * `showcase-ecommerce` datapack. The questions and their answer keys are
 * written by a different model, from a different vendor to the one that answers
 * them, and it is shown exactly one thing: `catalog-dump.json`, a flat read of
 * that catalog off a live GMS. It never sees instaboard's system prompt, its
 * tool list, the skill, the README, the scorer's source, or the cases we wrote
 * ourselves. It is not told there are arms, that DataHub is involved, or what
 * the thing being measured can do.
 *
 * What that buys, precisely: nobody who knew what this tool is good at chose
 * these questions. What it does not buy: we wrote the instructions to the
 * author, and those instructions shape the set. They are committed verbatim in
 * `author-prompt.md` so the shaping is auditable rather than asserted.
 *
 * ── The filter ────────────────────────────────────────────────────────────
 *
 * A generated case can be unusable in ways that have nothing to do with
 * difficulty: an answer key naming a table that isn't in the catalog tests
 * nothing, and a `mustNotInclude` needle that *is* in the catalog fails correct
 * answers. Both are checked mechanically here, before any arm runs, and every
 * rejection is written into `cases.json` with its reason. The filter is
 * deterministic and blind to how hard a case is — no case is ever dropped for
 * being one instaboard fails, and nothing is dropped after seeing a score.
 * `--validate-only` re-runs it against the frozen file so a reader can confirm
 * that on their own machine.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLLMTurn } from "../../lib/providers";
import type { LLMConfig } from "../../lib/types";

const HERE = path.join(process.cwd(), "evals", "holdout");
const DUMP_PATH = path.join(HERE, "catalog-dump.json");
const PROMPT_PATH = path.join(HERE, "author-prompt.md");
const CASES_PATH = path.join(HERE, "cases.json");

const args = process.argv.slice(2);
const validateOnly = args.includes("--validate-only");

/**
 * Deliberately not the model that answers the benchmark. The answering arms run
 * on NVIDIA's Nemotron; the author is Google's Gemma, so "the author and the
 * examinee are the same system" is not an available objection either. Override
 * with HOLDOUT_AUTHOR_MODEL.
 *
 * If a second independent author is ever added, it gets its own cases file and
 * its own published score. Re-authoring *this* set with a better model after
 * seeing what the first one scored is precisely how a held-out set stops being
 * held out, so the file refuses to overwrite itself.
 */
const AUTHOR_MODEL = process.env.HOLDOUT_AUTHOR_MODEL || "google/gemma-4-31b-it:free";

/* ── Env ──────────────────────────────────────────────────────────────── */

function loadDotEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(path.join(process.cwd(), file), "utf8").split("\n")) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      /* absent — fine */
    }
  }
}

/* ── Shapes ───────────────────────────────────────────────────────────── */

interface CheckGroup {
  label: string;
  anyOf: string[];
}

interface AuthoredCase {
  id: string;
  category: string;
  question: string;
  stakes: string;
  mustInclude: CheckGroup[];
  mustNotInclude?: CheckGroup[];
}

interface Rejection {
  id: string;
  reason: string;
  detail: string;
}

/* ── The mechanical filter ────────────────────────────────────────────── */

/**
 * Matches the scorer in evals/score.ts: case-insensitive, whitespace collapsed,
 * markdown emphasis stripped. A needle is "in the catalog" if it appears
 * anywhere in the dump under the same normalization the scorer uses on answers.
 */
function normalize(text: string): string {
  return text.replace(/[*_`]/g, "").replace(/\s+/g, " ").toLowerCase();
}

/**
 * Needles that are turns of phrase rather than catalog facts — "not recorded",
 * "no owner is listed". Requiring those to appear in the dump would throw away
 * exactly the cases rule 4 asked for, so a group counts as grounded if any of
 * its alternatives is found, and a case is kept if any of its groups is.
 */
function validate(authored: AuthoredCase[], dump: string): { kept: AuthoredCase[]; rejected: Rejection[] } {
  const haystack = normalize(dump);
  const kept: AuthoredCase[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();

  for (const c of authored) {
    if (!c.id || !c.question || !Array.isArray(c.mustInclude) || c.mustInclude.length === 0) {
      rejected.push({ id: c.id ?? "(no id)", reason: "malformed", detail: "missing id, question or mustInclude" });
      continue;
    }
    if (seen.has(c.id)) {
      rejected.push({ id: c.id, reason: "duplicate id", detail: "a case with this id was already accepted" });
      continue;
    }

    const groundedGroups = c.mustInclude.filter((g) =>
      (g.anyOf ?? []).some((needle) => haystack.includes(normalize(needle))),
    );
    if (groundedGroups.length === 0) {
      rejected.push({
        id: c.id,
        reason: "no check is grounded in the catalog",
        detail: `none of ${c.mustInclude.length} mustInclude group(s) names anything present in the dump`,
      });
      continue;
    }

    // A forbidden string that is actually in the catalog would fail a correct
    // answer. Drop the offending group rather than the case; the rest still
    // measures something, and the drop is recorded.
    const badNegatives = (c.mustNotInclude ?? []).filter((g) =>
      (g.anyOf ?? []).some((needle) => haystack.includes(normalize(needle))),
    );
    if (badNegatives.length > 0) {
      rejected.push({
        id: c.id,
        reason: "mustNotInclude group dropped (present in the catalog)",
        detail: badNegatives.map((g) => `${g.label}: ${g.anyOf.join(", ")}`).join(" · "),
      });
    }

    seen.add(c.id);
    kept.push({
      ...c,
      mustNotInclude: (c.mustNotInclude ?? []).filter((g) => !badNegatives.includes(g)),
    });
  }

  return { kept, rejected };
}

/* ── Generation ───────────────────────────────────────────────────────── */

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`no JSON array in the author's reply:\n${text.slice(0, 400)}`);
  return JSON.parse(body.slice(start, end + 1));
}

async function main(): Promise<void> {
  loadDotEnv();

  if (!existsSync(DUMP_PATH)) {
    console.error("No catalog dump. Run `npx tsx evals/holdout/dump-catalog.ts` against a live DataHub first.");
    process.exit(1);
  }
  const dumpRaw = readFileSync(DUMP_PATH, "utf8");
  const promptRaw = readFileSync(PROMPT_PATH, "utf8");
  const dumpSha = createHash("sha256").update(dumpRaw).digest("hex");
  const promptSha = createHash("sha256").update(promptRaw).digest("hex");

  if (validateOnly) {
    const frozen = JSON.parse(readFileSync(CASES_PATH, "utf8")) as {
      provenance: { catalogDumpSha256: string; authorPromptSha256: string };
      cases: AuthoredCase[];
    };
    const drifted: string[] = [];
    if (frozen.provenance.catalogDumpSha256 !== dumpSha) drifted.push("catalog-dump.json");
    if (frozen.provenance.authorPromptSha256 !== promptSha) drifted.push("author-prompt.md");
    if (drifted.length > 0) {
      console.error(`✗ ${drifted.join(" and ")} changed since the cases were authored.`);
      console.error("  The frozen cases no longer correspond to what the author was shown.");
      process.exit(1);
    }
    const { kept, rejected } = validate(frozen.cases, dumpRaw);
    if (kept.length !== frozen.cases.length) {
      console.error(`✗ ${frozen.cases.length - kept.length} frozen case(s) no longer pass the filter:`);
      for (const r of rejected) console.error(`  ${r.id}: ${r.reason} — ${r.detail}`);
      process.exit(1);
    }
    console.log(`✓ ${kept.length} frozen cases still ground out against the same catalog dump.`);
    console.log(`  dump sha256   ${dumpSha}`);
    console.log(`  prompt sha256 ${promptSha}`);
    return;
  }

  if (existsSync(CASES_PATH)) {
    console.error(`${path.relative(process.cwd(), CASES_PATH)} already exists.`);
    console.error("These cases are held out: re-authoring them after seeing a score is how a held-out set stops");
    console.error("being one. Delete the file deliberately if you really mean to generate a new set.");
    process.exit(1);
  }

  const apiKey = process.env.LLM_API_KEY;
  const provider = (process.env.HOLDOUT_AUTHOR_PROVIDER || "openrouter") as LLMConfig["provider"];
  if (!apiKey) {
    console.error("Set LLM_API_KEY in .env.local (the author runs through the same provider plumbing as the arms).");
    process.exit(1);
  }

  console.log(`Authoring held-out cases with ${AUTHOR_MODEL} via ${provider}…`);
  console.log(`  catalog dump: ${JSON.parse(dumpRaw).datasetCount} datasets, sha256 ${dumpSha.slice(0, 12)}…`);

  const turn = await runLLMTurn(
    { provider, apiKey, model: AUTHOR_MODEL },
    promptRaw,
    [{ kind: "user", content: `Here is the catalog JSON.\n\n${dumpRaw}` }],
    [],
  );

  const authored = extractJson(turn.text ?? "") as AuthoredCase[];
  console.log(`  author returned ${authored.length} case(s)`);

  const { kept, rejected } = validate(authored, dumpRaw);
  console.log(`  ${kept.length} kept, ${rejected.length} rejection(s) recorded`);
  for (const r of rejected) console.log(`    ${r.id}: ${r.reason}`);

  writeFileSync(
    CASES_PATH,
    JSON.stringify(
      {
        provenance: {
          catalog: "showcase-ecommerce, DataHub's published demo datapack",
          authorModel: AUTHOR_MODEL,
          authorProvider: provider,
          catalogDumpSha256: dumpSha,
          authorPromptSha256: promptSha,
          casesReturned: authored.length,
          casesKept: kept.length,
          note:
            "Written by the model above from catalog-dump.json and author-prompt.md and nothing else. " +
            "It was not shown instaboard's prompts, tools, scorer or existing benchmark cases, and was not " +
            "told what system would answer these questions. Rejections below were applied by the mechanical " +
            "filter in author.ts before any arm ran; re-check with `--validate-only`.",
        },
        rejected,
        cases: kept,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${path.relative(process.cwd(), CASES_PATH)}`);
  console.log("\nCommit this file before running the benchmark. The git history is the hold-out record.");
}

void main();
