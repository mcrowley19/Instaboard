/**
 * How good is the decay engine, actually?
 *
 *   npm run bench:drift
 *
 * `npm run prove` breaks three things and checks all three are caught. That is a
 * demonstration with N=1 per kind, and it measures only recall — it cannot tell
 * you how often the engine fires when nothing is wrong, which is the number that
 * decides whether a team keeps it switched on.
 *
 * This plants many drifts of each kind across every stored runbook, mixed with
 * two kinds of negative case, then validates every runbook blind and scores it.
 *
 *   **Decoys** — real changes to things no runbook reads. Must produce nothing.
 *   **Controls** — real changes to things runbooks *do* read, which take nothing
 *   away: a column added, a description rewritten, a second owner appointed.
 *   Every one moves the aspect fingerprint a claim is pinned to, so a detector
 *   that equates "the aspect changed" with "the runbook broke" fires on all of
 *   them. These are the harder negatives, and they are where a real catalog
 *   spends most of its time.
 *
 * Four things make the numbers honest:
 *
 *   1. **A baseline pass.** Findings that already existed before anything was
 *      planted are excluded from the false-positive count. A runbook that was
 *      already stale is not the engine's fault, and counting it would understate
 *      precision.
 *   2. **Independent ground truth.** Which columns a step "really" reads is
 *      derived by tokenising its SQL, not by asking the engine's own reference
 *      matcher. Otherwise recall would be the harness agreeing with itself.
 *   3. **Decoys on datasets runbooks do use.** The sharp case is dropping a
 *      column from a table a runbook reads, where the runbook never mentions
 *      that column. The engine holds a snapshot of that entity and must still
 *      stay quiet.
 *   4. **A planted case no name-based matcher can solve.** One rename goes to a
 *      name sharing no tokens with the original. Detection should still catch
 *      the column as missing. The correction is reachable only structurally —
 *      one column left, one arrived, in the same slot — and if that evidence is
 *      absent the benchmark reports the miss with its reason rather than
 *      quietly omitting the case. A benchmark that cannot fail is not evidence,
 *      so this case is kept exactly as it was when the tool did fail it.
 *
 * Two axes are scored separately, because they fail separately:
 *
 *   **Detection** — did the engine notice the catalog moved?
 *   **Correction** — could it work out what to put instead? This is the weaker
 *   half. It is two signals — what the names say, and failing that what the
 *   shape of the change says — and both can be wrong in ways detection cannot,
 *   so the score is reported separately and never averaged in.
 *
 * Everything is restored afterwards, and the restore is verified.
 *
 *   npm run bench:drift             # run it against a live DataHub
 *   npm run bench:drift -- --verify # re-derive the published table from the
 *                                   # committed JSON, no DataHub needed
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectDecayWithState, snapshotEntity } from "../lib/decay";
import {
  injectDrift,
  planControls,
  planDrifts,
  revertDrift,
  type PlannedDrift,
} from "../lib/drift-injection";
import { listHandoffs } from "../lib/handoff-store";
import { isDemoMode } from "../lib/mcp";
import { callDataHubTool } from "../lib/mcp";
import { proposeFix } from "../lib/remediate";
import { driftTable, extractTable, scorecard, type BenchmarkResult } from "../lib/drift-scorecard";
import type { DecayFinding, DecayReport, EntitySnapshot, Handoff } from "../lib/types";

const args = process.argv.slice(2);
const json = args.includes("--json");
const keep = args.includes("--keep");
const verify = args.includes("--verify");
const maxPerKind = Number(args.find((a) => a.startsWith("--per-kind="))?.split("=")[1] || 6);
const decoyCount = Number(args.find((a) => a.startsWith("--decoys="))?.split("=")[1] || 6);
const controlCount = Number(args.find((a) => a.startsWith("--controls="))?.split("=")[1] || 3);

const OUT = path.join(process.cwd(), "examples", "live", "drift-benchmark.json");
const SCORECARD = path.join(process.cwd(), "evals", "results", "drift-scorecard.md");
const INDEX_LAG_MS = 25_000;

const say = (m: string) => {
  if (!json) console.log(m);
};

/** A finding, identified well enough to match against a planted drift. */
const fingerprint = (f: DecayFinding) => `${f.urn}|${f.kind}|${f.detail}`;

interface Validation {
  runbook: Handoff;
  report: DecayReport;
  live: Record<string, EntitySnapshot>;
}

async function validateAll(runbooks: Handoff[]): Promise<Validation[]> {
  const out: Validation[] = [];
  for (const runbook of runbooks) {
    const { report, live } = await detectDecayWithState(runbook);
    out.push({ runbook, report, live });
  }
  return out;
}

const findingsOf = (validations: Validation[]) => validations.flatMap((v) => v.report.findings);

/** Did this finding report the drift we planted? */
function matches(drift: PlannedDrift, finding: DecayFinding): boolean {
  if (finding.urn !== drift.urn) return false;
  if (drift.expect && finding.kind !== drift.expect) return false;
  // Column drift has to name the column, or it is a different finding that
  // happens to be on the same entity.
  if (drift.kind === "column-dropped" || drift.kind === "column-renamed") {
    return finding.detail.includes(drift.subject);
  }
  return true;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Why a planted drift went undetected.
 *
 * Recorded at plant time where it is known (`hardCase`), and otherwise derived
 * from the kind. A miss reported without a reason is a number to explain away;
 * a miss reported with one is a limit somebody can act on.
 */
function missReason(drift: PlannedDrift): string {
  if (drift.hardCase) return drift.hardCase;
  switch (drift.kind) {
    case "column-dropped":
    case "column-renamed":
      return (
        `the step's dependency on \`${drift.subject}\` is detected by word-boundary matching its prose and SQL, ` +
        `so a column reached through \`SELECT *\` or an alias is invisible to it`
      );
    case "deprecated":
      return "the step's entity was already deprecated at record time, so there was no transition to see";
    case "owner-removed":
      return `the step never names ${drift.subject} in a form the owner matcher recognises`;
    default:
      return "no structural reason recorded — worth investigating before trusting this row";
  }
}

/**
 * Why no correction was derived for a drift that *was* detected.
 *
 * Taken from the remediator's own `unresolved` entry wherever it wrote one, so
 * the published reason is the reason in the code rather than one composed
 * afterwards to fit the result. `hardCase` is the fallback for a plant designed
 * to be unsolvable; the last fallback says plainly that we do not know, which is
 * worth more than a plausible guess.
 */
function correctionMissReason(drift: PlannedDrift, proposals: { unresolved: { detail: string; needsHuman: string }[] }[]): string {
  const own = proposals
    .flatMap((p) => p.unresolved)
    .find((u) => u.detail.includes(drift.subject));
  if (own) return own.needsHuman;
  if (drift.hardCase) return drift.hardCase;
  return "the remediator produced neither an edit nor an explanation — investigate before trusting this row";
}

/** Re-derive the published table from the committed run, without a DataHub. */
function runVerify(): never {
  const committed = JSON.parse(readFileSync(OUT, "utf8")) as BenchmarkResult;
  const regenerated = scorecard(committed);
  const onDisk = (() => {
    try {
      return readFileSync(SCORECARD, "utf8");
    } catch {
      return "";
    }
  })();

  const table = driftTable(committed);
  const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
  const inReadme = extractTable(readme);

  const problems: string[] = [];
  if (onDisk.trim() !== regenerated.trim()) problems.push(`${path.relative(process.cwd(), SCORECARD)} is out of date`);
  if (inReadme === null) problems.push("README.md has no drift-table markers");
  else if (inReadme !== table) problems.push("the table in README.md does not match the committed run");

  if (problems.length) {
    console.error("Published drift numbers do not match the committed run:");
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error("\nRe-run `npm run bench:drift` against a DataHub, or paste the regenerated table below:\n");
    console.error(table);
    process.exit(2);
  }

  console.log(`✓ README.md and ${path.relative(process.cwd(), SCORECARD)} both match ${path.relative(process.cwd(), OUT)}`);
  console.log(`  run at ${committed.at}, ${committed.detection.detected}/${committed.detection.plantedTotal} drifts detected`);
  process.exit(0);
}

async function main() {
  if (verify) runVerify();

  if (isDemoMode()) {
    console.error("DEMO_MODE is set. This benchmark mutates a real catalog, so unset it.");
    process.exit(1);
  }

  const runbooks = listHandoffs();
  if (runbooks.length === 0) {
    console.error("No runbooks stored. Run `npm run draft -- --query=<domain> --save` or record one first.");
    process.exit(1);
  }
  say(`\nScoring the decay engine against ${runbooks.length} stored runbook(s).`);

  /* ── 1. Baseline: what is already wrong, before we touch anything ────── */
  say("\n1/5  baseline validation (excluding pre-existing drift from the score)…");
  const baseline = findingsOf(await validateAll(runbooks));
  const preExisting = new Set(baseline.map(fingerprint));
  say(`     ${baseline.length} pre-existing finding(s) — these cannot count against precision.`);

  /* ── 2. Read the catalog as the planner sees it ──────────────────────── */
  say("\n2/5  reading current catalog state…");
  const urns = [...new Set(runbooks.flatMap((r) => r.steps.map((s) => s.urn).filter(Boolean) as string[]))];
  const live: Record<string, EntitySnapshot> = {};
  for (const urn of urns) live[urn] = await snapshotEntity(urn);

  // Decoy candidates: datasets runbooks touch (the sharp case) plus a few the
  // catalog holds that they don't.
  const decoyCandidates: EntitySnapshot[] = Object.values(live);
  const extra = await callDataHubTool("search", { query: "*", num_results: 30 });
  if (!extra.isError) {
    const found = [...extra.content.matchAll(/urn:li:dataset:\([^()]*\)/g)].map((m) => m[0]);
    for (const urn of found.slice(0, 12)) {
      if (live[urn]) continue;
      const snap = await snapshotEntity(urn);
      if (snap.exists && snap.fields.length > 1) decoyCandidates.push(snap);
    }
  }

  /* ── 3. Plant ────────────────────────────────────────────────────────── */
  const plans = [
    ...planDrifts(runbooks, live, decoyCandidates, { maxPerKind, decoys: decoyCount }),
    ...planControls(runbooks, live, controlCount),
  ];
  const real = plans.filter((p) => !p.decoy);
  const decoys = plans.filter((p) => p.decoy && !p.control);
  const controls = plans.filter((p) => p.control);
  say(`\n3/5  planting ${real.length} drift(s), ${decoys.length} decoy(s) and ${controls.length} control(s)…`);

  const injected: PlannedDrift[] = [];
  for (const plan of plans) {
    const ok = await injectDrift(plan);
    if (ok) {
      injected.push(plan);
      say(`     ${plan.decoy ? "decoy" : "drift"} · ${plan.detail}`);
    } else {
      say(`     • skipped (could not apply): ${plan.detail}`);
    }
  }

  say("     waiting for DataHub to index the changes…");
  await new Promise((r) => setTimeout(r, INDEX_LAG_MS));

  /* ── 4. Validate blind and score ─────────────────────────────────────── */
  say("\n4/5  validating every runbook (the engine is told nothing)…");
  const validations = await validateAll(runbooks);
  const after = findingsOf(validations);

  // Findings that are new since the baseline. Anything already there is somebody
  // else's problem, not a false positive of ours.
  const fresh = after.filter((f) => !preExisting.has(fingerprint(f)));

  const plantedReal = injected.filter((p) => !p.decoy);
  const perKind: Record<string, { tp: number; fn: number }> = {};

  /*
   * Two different units, on purpose.
   *
   * **Recall is per planted drift**: did the engine notice this change at all?
   * **Precision is per finding**: is this warning explained by something we
   * planted, or did the engine invent it?
   *
   * They have to be counted separately because one planted drift legitimately
   * produces several findings — two runbooks reading the same table both report
   * a dropped column, and both are right. Consuming findings one-per-drift would
   * score the second one as a false positive, which would be the harness
   * misunderstanding the engine rather than the engine being wrong.
   */
  const missed: PlannedDrift[] = [];
  for (const drift of plantedReal) {
    perKind[drift.kind] ??= { tp: 0, fn: 0 };
    if (fresh.some((f) => matches(drift, f))) perKind[drift.kind].tp++;
    else {
      missed.push(drift);
      perKind[drift.kind].fn++;
    }
  }
  const detected = plantedReal.length - missed.length;

  const explained = fresh.filter((f) => plantedReal.some((d) => matches(d, f)));
  const falseAlarms = fresh.filter((f) => !plantedReal.some((d) => matches(d, f)));

  const recall = plantedReal.length === 0 ? 1 : detected / plantedReal.length;
  // Precision over findings, which is the number an on-call engineer feels.
  const precision = fresh.length === 0 ? 1 : explained.length / fresh.length;
  const detection = {
    plantedTotal: plantedReal.length,
    detected,
    findingsExplained: explained.length,
    findingsTotal: fresh.length,
    falsePositives: falseAlarms.length,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };

  /*
   * Negatives, scored per planted change rather than per finding. Attribution is
   * by dataset: a control shares its table with whatever drift was planted there,
   * and anything unexplained landing on that table is charged to the control.
   */
  const injectedNegatives = injected.filter((p) => p.decoy);
  const negativeDetail = injectedNegatives.map((n) => {
    const fired = falseAlarms.filter((f) => f.urn === n.urn);
    return {
      id: n.id,
      kind: n.kind,
      urn: n.urn,
      control: Boolean(n.control),
      quiet: fired.length === 0,
      findings: fired.map((f) => `${f.kind}: ${f.detail}`),
    };
  });
  const negatives = {
    decoysPlanted: negativeDetail.filter((n) => !n.control).length,
    decoysQuiet: negativeDetail.filter((n) => !n.control && n.quiet).length,
    controlsPlanted: negativeDetail.filter((n) => n.control).length,
    controlsQuiet: negativeDetail.filter((n) => n.control && n.quiet).length,
    detail: negativeDetail,
  };

  /*
   * The second axis. Detecting that `net_amount_usd` is gone is a schema diff and
   * it is reliable; working out that it is now called `settled_value` is string
   * similarity and it is not. Scoring them together would let the strong half
   * carry the weak one.
   */
  const renames = plantedReal.filter((d) => d.kind === "column-renamed" && fresh.some((f) => matches(d, f)));
  const proposals = validations
    .filter((v) => v.report.severity !== "ok")
    .map((v) => proposeFix(v.runbook, v.report, v.live));
  const correctionMisses: { id: string; from: string; to: string; reason: string }[] = [];
  let proposed = 0;
  for (const rename of renames) {
    const derived = proposals.some((p) =>
      p.edits.some((e) => e.kind === "column-rename" && e.from === rename.subject && e.to === rename.renameTo)
    );
    if (derived) proposed++;
    else {
      correctionMisses.push({
        id: rename.id,
        from: rename.subject,
        to: rename.renameTo ?? "?",
        reason: correctionMissReason(rename, proposals),
      });
    }
  }
  const corrections = { eligible: renames.length, proposed, misses: correctionMisses };

  if (!json) {
    console.log(`\n     planted drifts detected : ${detection.detected}/${detection.plantedTotal}`);
    console.log(`     fresh findings explained: ${detection.findingsExplained}/${detection.findingsTotal}`);
    console.log(`     missed         : ${missed.length}${missed.length ? " — " + missed.map((m) => m.id).join(", ") : ""}`);
    console.log(`     unexplained    : ${detection.falsePositives}`);
    for (const f of falseAlarms) console.log(`        ✗ ${f.kind} on ${f.urn.slice(-40)}: ${f.detail.slice(0, 90)}`);
    console.log(`\n     precision ${pct(detection.precision)} · recall ${pct(detection.recall)} · F1 ${pct(detection.f1)}`);
    console.log("\n     by kind:");
    for (const [kind, counts] of Object.entries(perKind)) {
      const r = counts.tp + counts.fn === 0 ? 1 : counts.tp / (counts.tp + counts.fn);
      console.log(`       ${kind.padEnd(16)} recall ${pct(r)}  (${counts.tp}/${counts.tp + counts.fn})`);
    }
    console.log(
      `\n     decoys   ${negatives.decoysQuiet}/${negatives.decoysPlanted} stayed quiet` +
        `\n     controls ${negatives.controlsQuiet}/${negatives.controlsPlanted} stayed quiet ` +
        `(additive changes on datasets runbooks read)`
    );
    for (const n of negativeDetail.filter((n) => !n.quiet)) {
      console.log(`        ✗ ${n.control ? "control" : "decoy"} ${n.kind} fired: ${n.findings[0]?.slice(0, 100)}`);
    }
    console.log(`\n     corrections derived for detected renames: ${proposed}/${renames.length}`);
    for (const miss of correctionMisses) {
      console.log(`        ~ ${miss.from} → ${miss.to}`);
      console.log(`          ${miss.reason}`);
    }
  }

  /* ── 5. Restore ──────────────────────────────────────────────────────── */
  let restored = 0;
  if (keep) {
    say("\n5/5  leaving the catalog changed (--keep). Re-run without it to restore.");
  } else {
    say("\n5/5  restoring the catalog…");
    for (const drift of [...injected].reverse()) {
      if (await revertDrift(drift)) restored++;
    }
    say(`     restored ${restored}/${injected.length}`);
  }

  const result: BenchmarkResult = {
    at: new Date().toISOString(),
    catalog: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
    runbooks: runbooks.map((r) => ({ id: r.id, title: r.title, steps: r.steps.length })),
    method:
      "Known drifts planted through DataHub's own write APIs across every stored runbook, mixed with decoys " +
      "(changes to things no runbook reads) and controls (additive changes to things runbooks do read: a column " +
      "added, a description rewritten, a second owner appointed). Both classes must produce nothing. Ground truth " +
      "for column drift comes from tokenising each step's SQL, not from the engine's own reference matcher. One " +
      "rename is planted to a name sharing no tokens with the original, so no name-based matcher can solve it and " +
      "one that appeared to would be matching noise; it is solvable only from the shape of the change — one column " +
      "left, one arrived, in the same slot — and is proposed at lower confidence for that reason. Findings that " +
      "pre-date the injection are excluded from the false-positive count. The engine is told nothing about any of it.",
    baselineFindings: baseline.length,
    planted: injected.map((p) => ({
      id: p.id,
      kind: p.kind,
      urn: p.urn,
      subject: p.subject,
      decoy: p.decoy,
      ...(p.control ? { control: true } : {}),
      expect: p.expect,
      ...(p.hardCase ? { hardCase: p.hardCase } : {}),
    })),
    detection,
    byKind: Object.fromEntries(
      Object.entries(perKind).map(([kind, c]) => [
        kind,
        { truePositives: c.tp, falseNegatives: c.fn, recall: c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn) },
      ])
    ),
    negatives,
    corrections,
    falsePositives: falseAlarms.map((f) => ({ kind: f.kind, urn: f.urn, detail: f.detail })),
    falseNegatives: missed.map((m) => ({
      id: m.id,
      kind: m.kind,
      urn: m.urn,
      subject: m.subject,
      reason: missReason(m),
    })),
    restored: keep ? null : `${restored}/${injected.length}`,
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  mkdirSync(path.dirname(SCORECARD), { recursive: true });
  writeFileSync(SCORECARD, scorecard(result));

  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
    console.log(`wrote ${path.relative(process.cwd(), SCORECARD)}`);
    console.log("\nPaste this between the drift-table markers in README.md:\n");
    console.log(driftTable(result));
  }

  /*
   * A pipeline should fail on a detection collapse or a negative firing. The
   * correction axis deliberately does not gate: one of its cases is planted to be
   * unsolvable, so failing the build on it would mean deleting the honest case to
   * get green — exactly the pressure this benchmark exists to resist.
   */
  const negativesFired = negatives.decoysPlanted - negatives.decoysQuiet + (negatives.controlsPlanted - negatives.controlsQuiet);
  process.exit(detection.recall < 0.9 || detection.precision < 0.9 || negativesFired > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
