/**
 * The published drift-benchmark table, derived from the committed run.
 *
 * Kept out of the benchmark script on purpose. The script needs a live DataHub;
 * this does not, so the same function that writes the number can be re-run
 * offline by anyone — including the test that fails the build when the table in
 * the README stops matching `examples/live/drift-benchmark.json`. A published
 * score that cannot be re-derived from an artifact is a claim, not a result.
 *
 *   npm run bench:drift -- --verify   # re-derive and diff, no DataHub needed
 */

export interface BenchmarkResult {
  at: string;
  catalog: string;
  runbooks: { id: string; title: string; steps: number }[];
  method: string;
  baselineFindings: number;
  planted: {
    id: string;
    kind: string;
    urn: string;
    subject: string;
    decoy: boolean;
    control?: boolean;
    expect: string | null;
    hardCase?: string;
  }[];
  detection: {
    plantedTotal: number;
    detected: number;
    findingsExplained: number;
    findingsTotal: number;
    falsePositives: number;
    precision: number;
    recall: number;
    f1: number;
  };
  byKind: Record<string, { truePositives: number; falseNegatives: number; recall: number }>;
  negatives: {
    decoysPlanted: number;
    decoysQuiet: number;
    controlsPlanted: number;
    controlsQuiet: number;
    detail: { id: string; kind: string; urn: string; control: boolean; quiet: boolean; findings: string[] }[];
  };
  corrections: {
    eligible: number;
    proposed: number;
    misses: { id: string; from: string; to: string; reason: string }[];
  };
  falsePositives: { kind: string; urn: string; detail: string }[];
  falseNegatives: { id: string; kind: string; urn: string; subject: string; reason: string }[];
  restored: string | null;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Markers so the README can embed exactly this table and a test can diff it. */
export const TABLE_START = "<!-- drift-table:start -->";
export const TABLE_END = "<!-- drift-table:end -->";

/**
 * The table itself. Every row is a count taken straight off the run — nothing
 * here is rounded up, and the miss rows are printed whether or not there are any.
 */
export function driftTable(r: BenchmarkResult): string {
  const kinds = Object.keys(r.byKind).length;
  const restored = r.restored ?? "not restored (--keep)";

  const rows = [
    ["Planted drifts detected", `**${r.detection.detected}/${r.detection.plantedTotal}** across ${kinds} kinds`],
    [
      "Controls that stayed quiet",
      `**${r.negatives.controlsQuiet}/${r.negatives.controlsPlanted}** — column added, description edited, column description reworded, owner appended`,
    ],
    ["Decoys that stayed quiet", `**${r.negatives.decoysQuiet}/${r.negatives.decoysPlanted}**`],
    ["Unexplained findings", `**${r.detection.falsePositives}**`],
    [
      "Detection precision · recall · F1",
      `**${pct(r.detection.precision)} · ${pct(r.detection.recall)} · ${pct(r.detection.f1)}**`,
    ],
    [
      "Corrections derived for detected renames",
      `**${r.corrections.proposed}/${r.corrections.eligible}**${
        r.corrections.misses.length ? ` — ${r.corrections.misses.length} named below` : ""
      }`,
    ],
    ["Catalog changes restored afterwards", restored],
  ];

  return [
    TABLE_START,
    "| | Result |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    TABLE_END,
  ].join("\n");
}

/** The misses, each with the structural reason it was missed. */
export function missesSection(r: BenchmarkResult): string {
  const lines: string[] = [];

  if (r.falseNegatives.length === 0 && r.corrections.misses.length === 0) {
    lines.push(
      "Nothing was missed on this run. That is a smaller claim than it looks: the corpus is " +
        `${r.detection.plantedTotal} planted drifts and ` +
        `${r.negatives.decoysPlanted + r.negatives.controlsPlanted} negatives, which is enough to catch a broken ` +
        "detector and not enough to put a confidence interval on a perfect score."
    );
    return lines.join("\n");
  }

  if (r.falseNegatives.length) {
    lines.push("**Drift the engine did not detect:**", "");
    for (const miss of r.falseNegatives) {
      lines.push(`- \`${miss.kind}\` on \`${miss.subject}\` — ${miss.reason}`);
    }
    lines.push("");
  }

  if (r.corrections.misses.length) {
    lines.push("**Drift it detected but could not derive a correction for:**", "");
    for (const miss of r.corrections.misses) {
      lines.push(`- \`${miss.from}\` → \`${miss.to}\` — ${miss.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** The whole scorecard document, written next to the eval scorecards. */
export function scorecard(r: BenchmarkResult): string {
  const kindRows = Object.entries(r.byKind)
    .map(([kind, c]) => `| \`${kind}\` | ${c.truePositives}/${c.truePositives + c.falseNegatives} | ${pct(c.recall)} |`)
    .join("\n");

  const negatives = r.negatives.detail
    .map(
      (n) =>
        `| ${n.control ? "control" : "decoy"} | \`${n.kind}\` | ${n.quiet ? "✓ quiet" : "✗ fired"} | ${
          n.findings.length ? n.findings.join("; ").slice(0, 120) : "—"
        } |`
    )
    .join("\n");

  return [
    "# Drift benchmark",
    "",
    "Generated by `npm run bench:drift` from a live DataHub, and re-derivable from",
    "[`examples/live/drift-benchmark.json`](../../examples/live/drift-benchmark.json) with",
    "`npm run bench:drift -- --verify`. `npm test` fails if the table below and the one in the README",
    "stop matching this file.",
    "",
    `Run at ${r.at} against ${r.catalog}, over ${r.runbooks.length} stored runbook${
      r.runbooks.length === 1 ? "" : "s"
    }.`,
    "",
    driftTable(r),
    "",
    "## What was missed",
    "",
    missesSection(r),
    "",
    "## Recall by drift kind",
    "",
    "| Kind | Detected | Recall |",
    "| --- | --- | --- |",
    kindRows || "| — | — | — |",
    "",
    "## Every negative case, and what it produced",
    "",
    "Decoys change something no runbook reads. Controls change something runbooks do read,",
    "without taking anything away — the case a fingerprint-only detector gets wrong.",
    "",
    "| Class | Change | Result | Findings produced |",
    "| --- | --- | --- | --- |",
    negatives || "| — | — | — | — |",
    "",
    "## Method",
    "",
    r.method,
    "",
    `Baseline pass found ${r.baselineFindings} pre-existing finding(s), excluded from the false-positive count.`,
    "",
  ].join("\n");
}

/**
 * Pull the table out of a document that embeds it, for the drift test. Returns
 * null when the markers are absent, which is itself a failure worth reporting.
 */
export function extractTable(document: string): string | null {
  const start = document.indexOf(TABLE_START);
  const end = document.indexOf(TABLE_END);
  if (start === -1 || end === -1 || end < start) return null;
  return document.slice(start, end + TABLE_END.length).trim();
}
