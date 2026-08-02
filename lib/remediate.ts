/**
 * From "this runbook is stale" to "here is the corrected runbook, review it".
 *
 * Detection that stops at a warning leaves the work where it was. Somebody still
 * has to open the runbook, work out which column replaced the dropped one, and
 * retype the SQL. That is the part nobody does, which is why runbooks rot in the
 * first place.
 *
 * So instaboard proposes the fix. Every correction in here is derived from the
 * catalog rather than generated:
 *
 *   • a dropped column is matched against the columns that appeared since, and
 *     only proposed as a rename when the match is close enough to defend;
 *   • a deprecated table is replaced with whatever its own deprecation note names;
 *   • a departed owner is replaced with whoever DataHub says owns it now.
 *
 * Nothing here edits anything on its own. The output is a unified diff and a
 * corrected copy, for a human to approve — as a file, or as a pull request. A
 * proposal a person has to accept is the right amount of automation for a
 * document whose whole value is that somebody trusted it.
 */

import { handoffToMarkdown } from "./handoff-store";
import { humanOwners } from "./provenance";
import type { DecayFinding, DecayReport, EntitySnapshot, Handoff, HandoffStep } from "./types";

/* ── Similarity, for rename detection ─────────────────────────────────── */

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

/** Token overlap on snake_case parts, blended with edit distance. */
function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase();
  const [x, y] = [norm(a), norm(b)];
  if (x === y) return 1;

  const edit = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const tokens = (s: string) => new Set(s.split(/[_\s.-]+/).filter(Boolean));
  const [tx, ty] = [tokens(x), tokens(y)];
  const shared = [...tx].filter((t) => ty.has(t)).length;
  const overlap = shared / Math.max(tx.size, ty.size);

  // Token overlap carries the weight: `net_amount_usd` → `net_revenue_usd` is an
  // obvious rename to a person and a mediocre edit-distance match.
  return 0.6 * overlap + 0.4 * edit;
}

/** Above this, a rename is proposed as an edit; below it, it goes to the human. */
const RENAME_THRESHOLD = 0.55;

/**
 * Which column replaced this one, if any?
 *
 * Candidates are columns on the entity now that were not there when the runbook
 * was recorded — a rename shows up as one disappearance and one appearance. The
 * runner-up matters: when two new columns match about equally well, guessing is
 * worse than saying so, and the finding goes to the unresolved list instead.
 */
export function renameCandidate(
  dropped: string,
  before: string[],
  after: string[]
): { field: string; score: number } | null {
  const appeared = after.filter((f) => !before.includes(f));
  const pool = appeared.length ? appeared : after;
  const ranked = pool
    .map((field) => ({ field, score: similarity(dropped, field) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < RENAME_THRESHOLD) return null;
  const runnerUp = ranked[1];
  if (runnerUp && best.score - runnerUp.score < 0.1) return null;
  return best;
}

/** The dataset a deprecation note points at, when it names one. */
export function replacementFromNote(note?: string): string | null {
  if (!note) return null;
  const urn = note.match(/urn:li:dataset:\([^)]*\)/)?.[0];
  if (urn) return urn;
  // "Use analytics.marts.fct_revenue_v2 instead", "superseded by ORDER_DETAILS_V2".
  const named = note.match(/(?:use|replaced by|superseded by|migrate to|see)\s+`?([A-Za-z0-9_.]+)`?/i)?.[1];
  return named ?? null;
}

/* ── Applying an edit to a step ───────────────────────────────────────── */

const FIELDS: (keyof Pick<HandoffStep, "instruction" | "why" | "tips" | "sql" | "title">)[] = [
  "title",
  "instruction",
  "why",
  "tips",
  "sql",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace a token across every prose and SQL field of a step, word-boundary matched.
 *
 * `qualified` matters for table names. A step that says
 * `FROM analytics.marts.mrr_monthly` and a replacement of
 * `analytics.marts.mrr_monthly_v2` produce `analytics.marts.analytics.marts.mrr_monthly_v2`
 * unless the substitution swallows the schema prefix already in the text. So when
 * replacing a dataset name, the pattern eats any dotted qualifier in front of it.
 */
function substitute(
  step: HandoffStep,
  from: string,
  to: string,
  options: { qualified?: boolean } = {}
): { step: HandoffStep; hits: number } {
  const prefix = options.qualified ? "(?:[A-Za-z0-9_]+\\.)*" : "";
  const pattern = new RegExp(`\\b${prefix}${escape(from)}\\b`, "gi");
  let hits = 0;
  const next: HandoffStep = { ...step };
  for (const key of FIELDS) {
    const value = next[key];
    if (typeof value !== "string") continue;
    const replaced = value.replace(pattern, () => {
      hits++;
      return to;
    });
    if (replaced !== value) next[key] = replaced;
  }
  return { step: next, hits };
}

/** Prepositions and verbs that mean a following `her`/`his` is not possessive. */
const NOT_A_NOUN = new Set([
  "about", "on", "for", "to", "with", "if", "and", "or", "but", "before", "after",
  "when", "because", "so", "then", "first", "instead", "directly", "in", "at",
]);

/**
 * Repoint a gendered pronoun that referred to the person being replaced.
 *
 * "ping Mike Rodriguez — he owns the dbt job" cannot simply become "ping Priya
 * Patel — he owns the dbt job": the sentence now says something false about a
 * real person, and the failure mode is worse than the staleness it was meant to
 * fix. Substituting the new owner's first name reads naturally and, unlike
 * rewriting to "they", needs no verb-agreement surgery.
 *
 * It is still a prose edit rather than a catalog fact, so any step this touches
 * comes back marked for a human read.
 */
function repointPronouns(step: HandoffStep, name: string): { step: HandoffStep; changed: boolean } {
  const first = name.split(/\s+/)[0];
  const next: HandoffStep = { ...step };
  let changed = false;

  for (const key of FIELDS) {
    const value = next[key];
    if (typeof value !== "string") continue;
    const replaced = value
      .replace(/\b(?:he|she|him|himself|herself)\b/gi, () => {
        changed = true;
        return first;
      })
      .replace(/\b(his|hers|her)\b(\s+)([A-Za-z]+)/gi, (whole, _pronoun, gap: string, following: string) =>
        NOT_A_NOUN.has(following.toLowerCase()) ? whole : ((changed = true), `${first}'s${gap}${following}`)
      )
      .replace(/\b(?:his|hers|her)\b/gi, () => {
        changed = true;
        return first;
      });
    if (replaced !== value) next[key] = replaced;
  }
  return { step: next, changed };
}

/* ── The proposal ─────────────────────────────────────────────────────── */

export interface ProposedEdit {
  stepIndex: number;
  stepTitle: string;
  kind: "column-rename" | "dataset-replacement" | "owner-update";
  from: string;
  to: string;
  /** Why this substitution and not another — the catalog evidence behind it. */
  rationale: string;
  /** How defensible the substitution is: `high` needs no judgement, `medium` does. */
  confidence: "high" | "medium";
  claimId?: string;
  occurrences: number;
}

export interface UnresolvedFinding {
  stepIndex: number;
  stepTitle: string;
  kind: DecayFinding["kind"];
  detail: string;
  /** Why this one can't be proposed automatically and needs a person. */
  needsHuman: string;
}

export interface RunbookProposal {
  runbookId: string;
  title: string;
  basedOn: { checkedAt: string; severity: DecayReport["severity"]; findings: number };
  edits: ProposedEdit[];
  unresolved: UnresolvedFinding[];
  /** The corrected runbook, ready to save if a reviewer accepts it. */
  updated: Handoff;
  /** Unified diff of the runbook's markdown, before → after. */
  diff: string;
  /** Who should review it: the people who own the drifted datasets today. */
  reviewers: string[];
  at: string;
}

/**
 * Derive a corrected runbook from a decay report and the live catalog.
 *
 * Findings that can't be corrected mechanically are not guessed at. They land in
 * `unresolved`, which is a smaller and much more honest ask of a human than
 * "here is a rewritten document, hope it's right".
 */
export function proposeFix(
  handoff: Handoff,
  report: DecayReport,
  live: Record<string, EntitySnapshot>
): RunbookProposal {
  const edits: ProposedEdit[] = [];
  const unresolved: UnresolvedFinding[] = [];
  const steps = handoff.steps.map((s) => ({ ...s }));
  const reviewers = new Set<string>();

  for (const finding of report.findings) {
    const step = steps[finding.stepIndex];
    const now = live[finding.urn];
    const then = handoff.snapshots?.[finding.urn];
    const where = { stepIndex: finding.stepIndex, stepTitle: finding.stepTitle };
    if (!step) continue;

    for (const owner of humanOwners(now?.owners ?? [])) reviewers.add(owner);

    switch (finding.kind) {
      case "column-missing": {
        const dropped = finding.detail.match(/`([^`]+)`/)?.[1];
        if (!dropped || !now) break;
        const candidate = renameCandidate(dropped, then?.fields ?? [], now.fields);
        if (!candidate) {
          unresolved.push({
            ...where,
            kind: finding.kind,
            detail: finding.detail,
            needsHuman:
              `No column on ${now.name ?? finding.urn} is a close enough match to \`${dropped}\` to propose as a ` +
              `rename. It may have been dropped outright, or split across several columns.`,
          });
          break;
        }
        const applied = substitute(step, dropped, candidate.field);
        steps[finding.stepIndex] = applied.step;
        edits.push({
          ...where,
          kind: "column-rename",
          from: dropped,
          to: candidate.field,
          rationale:
            `\`${candidate.field}\` is on ${now.name ?? finding.urn} now and was not when this runbook was ` +
            `recorded, and it is the closest match to \`${dropped}\` (${candidate.score.toFixed(2)}).`,
          confidence: candidate.score > 0.8 ? "high" : "medium",
          ...(finding.claimId ? { claimId: finding.claimId } : {}),
          occurrences: applied.hits,
        });
        break;
      }

      case "newly-deprecated":
      case "deprecated": {
        const replacement = replacementFromNote(now?.deprecationNote);
        if (!replacement) {
          unresolved.push({
            ...where,
            kind: finding.kind,
            detail: finding.detail,
            needsHuman:
              now?.deprecationNote
                ? `The deprecation note ("${now.deprecationNote}") does not name a replacement dataset.`
                : "The dataset is deprecated with no note, so the catalog does not say what to use instead.",
          });
          break;
        }
        // Point the step at the replacement, and rewrite any mention of the old
        // table name in the prose and SQL along with it.
        const oldName = now?.name ?? "";
        const isUrn = replacement.startsWith("urn:li:");
        let next: HandoffStep = { ...step, ...(isUrn ? { urn: replacement } : {}) };
        let hits = 0;
        if (oldName && !isUrn) {
          const applied = substitute(next, oldName, replacement, { qualified: true });
          next = applied.step;
          hits = applied.hits;
          // The note named a table, not a URN, so the step still points at the
          // deprecated entity. Say so rather than leaving a half-corrected step.
          unresolved.push({
            ...where,
            kind: finding.kind,
            detail: finding.detail,
            needsHuman:
              `The deprecation note names \`${replacement}\`, which is a table name rather than a URN, so this ` +
              `step's entity link still points at the deprecated dataset. Repoint it once the replacement is in ` +
              `the catalog.`,
          });
        }
        next.tips =
          `${next.tips ? `${next.tips} ` : ""}${oldName || finding.urn} was deprecated after this runbook was ` +
          `recorded; DataHub's deprecation note points here instead.`;
        steps[finding.stepIndex] = next;
        edits.push({
          ...where,
          kind: "dataset-replacement",
          from: oldName || finding.urn,
          to: replacement,
          rationale: `DataHub's deprecation note on ${oldName || finding.urn} names it: "${now?.deprecationNote}".`,
          confidence: "high",
          ...(finding.claimId ? { claimId: finding.claimId } : {}),
          occurrences: hits,
        });
        break;
      }

      case "owner-changed": {
        const gone = finding.detail.match(/contact ([^,]+), who no longer owns/)?.[1]?.trim();
        const current = humanOwners(now?.owners ?? []);
        if (!gone || current.length === 0) {
          unresolved.push({
            ...where,
            kind: finding.kind,
            detail: finding.detail,
            needsHuman: "Nobody owns this dataset in DataHub now, so there is no name to put in the step.",
          });
          break;
        }
        const applied = substitute(step, gone, current[0]);
        // A pronoun left behind after a name swap makes the step say something
        // untrue about a real person, so repoint those too.
        const repointed = repointPronouns(applied.step, current[0]);
        steps[finding.stepIndex] = repointed.step;
        edits.push({
          ...where,
          kind: "owner-update",
          from: gone,
          to: current[0],
          rationale:
            `DataHub lists ${current.join(", ")} as the owner${current.length === 1 ? "" : "s"} today.` +
            (repointed.changed
              ? ` Pronouns referring to ${gone} were repointed to ${current[0].split(/\s+/)[0]}; check the prose reads right.`
              : ""),
          confidence: repointed.changed ? "medium" : "high",
          ...(finding.claimId ? { claimId: finding.claimId } : {}),
          occurrences: applied.hits,
        });
        break;
      }

      case "entity-missing":
        unresolved.push({
          ...where,
          kind: finding.kind,
          detail: finding.detail,
          needsHuman:
            "The entity is gone from the catalog entirely, so there is nothing to read a replacement from. " +
            "Somebody has to say what this step should point at now.",
        });
        break;

      case "new-incident":
      case "failing-assertion":
        // Health findings are true today and may be false tomorrow. Editing the
        // runbook to describe a passing incident would be writing a fact with a
        // shelf life into a document meant to outlast it.
        unresolved.push({
          ...where,
          kind: finding.kind,
          detail: finding.detail,
          needsHuman:
            "This is a current health problem rather than a wrong instruction. The runbook does not need " +
            "editing; the table needs looking at before anyone follows this step.",
        });
        break;
    }
  }

  const updated: Handoff = { ...handoff, steps };
  return {
    runbookId: handoff.id,
    title: handoff.title,
    basedOn: { checkedAt: report.checkedAt, severity: report.severity, findings: report.findings.length },
    edits,
    unresolved,
    updated,
    diff: unifiedDiff(
      `a/runbooks/${handoff.id}.md`,
      `b/runbooks/${handoff.id}.md`,
      handoffToMarkdown(handoff),
      handoffToMarkdown(updated)
    ),
    reviewers: [...reviewers],
    at: new Date().toISOString(),
  };
}

/* ── Unified diff ─────────────────────────────────────────────────────── */

/**
 * A small unified diff over lines. Hand-rolled rather than pulled in, because
 * the whole need is one diff of one short markdown document and a dependency
 * that renders a PR body is a dependency in the deploy path.
 */
export function unifiedDiff(fromName: string, toName: string, before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === after) return "";

  // Longest common subsequence table — documents here are tens of lines.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  type Op = { tag: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push({ tag: " ", line: a[i], ai: i++, bi: j++ });
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ tag: "-", line: a[i], ai: i++, bi: j });
    else ops.push({ tag: "+", line: b[j], ai: i, bi: j++ });
  }
  while (i < a.length) ops.push({ tag: "-", line: a[i], ai: i++, bi: j });
  while (j < b.length) ops.push({ tag: "+", line: b[j], ai: i, bi: j++ });

  // Group changed ops into hunks with `context` unchanged lines either side.
  const changed = ops.map((o) => o.tag !== " ");
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((_, k) => {
    if (!changed[k]) return;
    for (let m = Math.max(0, k - context); m <= Math.min(ops.length - 1, k + context); m++) keep[m] = true;
  });

  const out: string[] = [`--- ${fromName}`, `+++ ${toName}`];
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && keep[k]) k++;
    const hunk = ops.slice(start, k);
    const aCount = hunk.filter((o) => o.tag !== "+").length;
    const bCount = hunk.filter((o) => o.tag !== "-").length;
    out.push(`@@ -${hunk[0].ai + 1},${aCount} +${hunk[0].bi + 1},${bCount} @@`);
    for (const op of hunk) out.push(`${op.tag}${op.line}`);
  }
  return out.join("\n") + "\n";
}

/* ── Rendering ────────────────────────────────────────────────────────── */

/** The proposal as a reviewable document — a PR body, or a file in `proposals/`. */
export function proposalToMarkdown(proposal: RunbookProposal): string {
  const lines = [
    `# Proposed runbook correction: ${proposal.title}`,
    "",
    `Validation on ${proposal.basedOn.checkedAt.slice(0, 10)} found ${proposal.basedOn.findings} problem` +
      `${proposal.basedOn.findings === 1 ? "" : "s"} with this runbook (severity: ${proposal.basedOn.severity}). ` +
      `Every correction below is derived from the catalog, not generated — the rationale names the evidence.`,
    "",
    `**Reviewers:** ${proposal.reviewers.join(", ") || "no owner listed on the affected datasets"}`,
    "",
  ];

  if (proposal.edits.length) {
    lines.push("## Proposed edits", "");
    lines.push("| Step | Change | From | To | Confidence | Why |", "| --- | --- | --- | --- | --- | --- |");
    for (const e of proposal.edits) {
      lines.push(
        `| ${e.stepIndex + 1} | ${e.kind} | \`${e.from}\` | \`${e.to}\` | ${e.confidence} | ${e.rationale} |`
      );
    }
    lines.push("");
  } else {
    lines.push("## Proposed edits", "", "None — nothing that drifted could be corrected mechanically.", "");
  }

  if (proposal.unresolved.length) {
    lines.push(
      "## Needs a person",
      "",
      "These are deliberately not auto-corrected. Guessing here would be worse than asking.",
      ""
    );
    for (const u of proposal.unresolved) {
      lines.push(`- **Step ${u.stepIndex + 1} (${u.kind})** — ${u.detail} ${u.needsHuman}`);
    }
    lines.push("");
  }

  if (proposal.diff) lines.push("## Diff", "", "```diff", proposal.diff.trimEnd(), "```", "");

  lines.push(
    "---",
    "_Proposed by instaboard's runbook decay sweep. Detection and correction are both deterministic reads of the " +
      "DataHub catalog; approving this is a human decision._"
  );
  return lines.join("\n");
}
