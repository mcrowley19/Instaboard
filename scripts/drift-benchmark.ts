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
 * **decoys**: real catalog changes that no runbook depends on and that must
 * produce nothing. Then it validates every runbook blind and scores precision,
 * recall and F1, overall and per kind.
 *
 * Three things make the number honest:
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
 *
 * Everything is restored afterwards, and the restore is verified.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectDecay, snapshotEntity } from "../lib/decay";
import {
  injectDrift,
  planDrifts,
  revertDrift,
  type DriftKind,
  type PlannedDrift,
} from "../lib/drift-injection";
import { listHandoffs } from "../lib/handoff-store";
import { isDemoMode } from "../lib/mcp";
import { callDataHubTool } from "../lib/mcp";
import type { DecayFinding, EntitySnapshot, Handoff } from "../lib/types";

const args = process.argv.slice(2);
const json = args.includes("--json");
const keep = args.includes("--keep");
const maxPerKind = Number(args.find((a) => a.startsWith("--per-kind="))?.split("=")[1] || 6);
const decoyCount = Number(args.find((a) => a.startsWith("--decoys="))?.split("=")[1] || 6);

const OUT = path.join(process.cwd(), "examples", "live", "drift-benchmark.json");
const INDEX_LAG_MS = 25_000;

const say = (m: string) => {
  if (!json) console.log(m);
};

/** A finding, identified well enough to match against a planted drift. */
const fingerprint = (f: DecayFinding) => `${f.urn}|${f.kind}|${f.detail}`;

async function validateAll(runbooks: Handoff[]): Promise<DecayFinding[]> {
  const findings: DecayFinding[] = [];
  for (const runbook of runbooks) {
    const report = await detectDecay(runbook);
    findings.push(...report.findings);
  }
  return findings;
}

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

interface Score {
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  precision: number;
  recall: number;
  f1: number;
}

function score(tp: number, fp: number, fn: number): Score {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function main() {
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
  const baseline = await validateAll(runbooks);
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
  const plans = planDrifts(runbooks, live, decoyCandidates, { maxPerKind, decoys: decoyCount });
  const real = plans.filter((p) => !p.decoy);
  const decoys = plans.filter((p) => p.decoy);
  say(`\n3/5  planting ${real.length} drift(s) and ${decoys.length} decoy(s)…`);

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
  const after = await validateAll(runbooks);

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
  const overall = {
    ...score(detected, falseAlarms.length, missed.length),
    findingsExplained: explained.length,
    findingsTotal: fresh.length,
    // Precision over findings, which is the number an on-call engineer feels.
    precision: fresh.length === 0 ? 1 : explained.length / fresh.length,
  };
  overall.f1 =
    overall.precision + overall.recall === 0
      ? 0
      : (2 * overall.precision * overall.recall) / (overall.precision + overall.recall);

  if (!json) {
    console.log(`\n     planted drifts detected : ${detected}/${plantedReal.length}`);
    console.log(`     fresh findings explained: ${overall.findingsExplained}/${overall.findingsTotal}`);
    console.log(`     missed         : ${overall.falseNegatives}${missed.length ? " — " + missed.map((m) => m.id).join(", ") : ""}`);
    console.log(`     unexplained    : ${overall.falsePositives}`);
    for (const f of falseAlarms) console.log(`        ✗ ${f.kind} on ${f.urn.slice(-40)}: ${f.detail.slice(0, 90)}`);
    console.log(`\n     precision ${pct(overall.precision)} · recall ${pct(overall.recall)} · F1 ${pct(overall.f1)}`);
    console.log("\n     by kind:");
    for (const [kind, counts] of Object.entries(perKind)) {
      const r = counts.tp + counts.fn === 0 ? 1 : counts.tp / (counts.tp + counts.fn);
      console.log(`       ${kind.padEnd(16)} recall ${pct(r)}  (${counts.tp}/${counts.tp + counts.fn})`);
    }
    console.log(
      `\n     decoys planted: ${injected.filter((p) => p.decoy).length}, of which ` +
        `${falseAlarms.filter((f) => injected.some((p) => p.decoy && p.urn === f.urn)).length} produced a finding.`
    );
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

  const result = {
    at: new Date().toISOString(),
    catalog: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
    runbooks: runbooks.map((r) => ({ id: r.id, title: r.title, steps: r.steps.length })),
    method:
      "Known drifts planted through DataHub's own write APIs across every stored runbook, mixed with decoys that " +
      "must produce nothing. Ground truth for column drift comes from tokenising each step's SQL, not from the " +
      "engine's own reference matcher. Findings that pre-date the injection are excluded from the false-positive " +
      "count. The engine is told nothing about any of it.",
    baselineFindings: baseline.length,
    planted: injected.map((p) => ({ id: p.id, kind: p.kind, urn: p.urn, subject: p.subject, decoy: p.decoy, expect: p.expect })),
    overall,
    byKind: Object.fromEntries(
      Object.entries(perKind).map(([kind, c]) => [
        kind,
        { truePositives: c.tp, falseNegatives: c.fn, recall: c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn) },
      ])
    ),
    falsePositives: falseAlarms.map((f) => ({ kind: f.kind, urn: f.urn, detail: f.detail })),
    falseNegatives: missed.map((m) => ({ id: m.id, kind: m.kind, urn: m.urn, subject: m.subject })),
    restored: keep ? null : `${restored}/${injected.length}`,
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));

  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);

  // A recall or precision collapse should fail a pipeline, not just print.
  process.exit(overall.recall < 0.9 || overall.precision < 0.9 ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
