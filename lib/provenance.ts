/**
 * Provenance: pinning every runbook claim to the catalog version it was checked against.
 *
 * "This runbook is stale" is a claim about the whole document, and it is not much
 * use to whoever has to fix it. The useful unit is smaller. A runbook step makes
 * several separate, individually checkable assertions about the catalog — this
 * dataset exists, it has a column called `net_amount_usd`, it is not deprecated,
 * Priya owns it — and staleness happens one assertion at a time.
 *
 * So instaboard breaks a runbook into **claims**, and pins each claim to the
 * version of the catalog aspect it was validated against. A version here is a
 * content fingerprint: hash the facts of the aspect (the field list, the owner
 * list, the deprecation flag, the health counters) and you get an identifier that
 * changes if and only if something a runbook could depend on changed. It is
 * computed from public catalog state, so anyone holding the runbook and a DataHub
 * connection can recompute it and check the pin, which is what separates a
 * provenance chain from a claim of one.
 *
 * The chain per claim reads:
 *
 *   step 2 claims column `net_amount_usd` exists
 *     → validated 2026-07-01 against schema aspect a41f9c02e7b1
 *     → schema aspect is 8d3e17ba4409 today
 *     → claim BROKEN, and here is the exact fact that moved.
 *
 * Every link is a value someone else can reproduce. No LLM sits anywhere in it.
 */

import { createHash } from "node:crypto";
import { sqlColumnRefs } from "./sql-refs";
import type {
  AspectName,
  ClaimPin,
  ClaimVerdict,
  CoverageDimension,
  EntitySnapshot,
  EntityVersion,
  HandoffStep,
  RevalidationCoverage,
  RunbookClaim,
  RunbookVerdict,
  StepCoverage,
} from "./types";

/* ── Fingerprinting ───────────────────────────────────────────────────── */

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/**
 * The facts of each aspect, canonicalised. Sorted, so that a catalog re-ingest
 * that returns the same fields in a different order does not read as drift —
 * a fingerprint that moves for reasons nobody can act on is noise.
 */
function aspectFacts(snapshot: EntitySnapshot): Record<AspectName, unknown> {
  return {
    schema: [...snapshot.fields].sort(),
    ownership: [...snapshot.owners].sort(),
    // The note is part of the deprecation aspect and carries the replacement
    // dataset, so a rewritten note is a change a runbook reader needs to see.
    deprecation: { deprecated: snapshot.deprecated, note: snapshot.deprecationNote ?? "" },
    health: { openIncidents: snapshot.openIncidents, failingAssertions: snapshot.failingAssertions },
  };
}

/** The aspects a runbook claim can be pinned to, in report order. */
export const ASPECTS: AspectName[] = ["schema", "ownership", "deprecation", "health"];

/**
 * Fingerprint one entity as the runbook sees it. Pure: same catalog state in,
 * same version out, on any machine, which is what makes the pin checkable.
 */
export function versionOf(snapshot: EntitySnapshot): EntityVersion {
  const facts = aspectFacts(snapshot);
  const aspects = Object.fromEntries(ASPECTS.map((a) => [a, hash(facts[a])])) as Record<AspectName, string>;
  return { entity: hash({ exists: snapshot.exists, ...aspects }), aspects };
}

/** The pin recorded on a claim: which aspect of which entity, at which version, when. */
export function pin(snapshot: EntitySnapshot, aspect: AspectName): ClaimPin {
  const version = snapshot.version ?? versionOf(snapshot);
  return {
    urn: snapshot.urn,
    aspect,
    aspectVersion: version.aspects[aspect],
    entityVersion: version.entity,
    at: snapshot.capturedAt,
  };
}

/* ── Reading what a step depends on ───────────────────────────────────── */

/**
 * Does this step's prose or SQL actually depend on the given identifier?
 *
 * Prose is word-boundary matched, because a runbook that says "check the
 * amount" must not be read as depending on a column called `amount_usd`, and
 * dropping `net_amount_usd` must not be read as breaking a step that only
 * mentions `net_amount_usd_v2`.
 *
 * SQL is parsed. A column named inside a string literal or a comment is not a
 * dependency, and only the syntax tree knows the difference. When the parser
 * cannot read the statement, or the statement selects `*`, the word match
 * takes over — over-reporting a dependency is recoverable noise, silently
 * dropping one is a missed break.
 */
export function stepReferences(step: Pick<HandoffStep, "instruction" | "why"> & Partial<HandoffStep>, token: string): boolean {
  const word = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (word.test([step.instruction, step.why, step.tips ?? ""].join(" "))) return true;
  if (!step.sql) return false;
  const refs = sqlColumnRefs(step.sql);
  if (refs && refs.complete) return refs.columns.includes(token.toLowerCase());
  return word.test(step.sql);
}

/** Owner display names the step tells the successor to go and talk to. */
export function ownersNamedIn(
  step: Pick<HandoffStep, "instruction" | "why"> & Partial<HandoffStep>,
  knownOwners: string[]
): string[] {
  const haystack = [step.instruction, step.why, step.tips ?? ""].join(" ");
  return knownOwners.filter((owner) => {
    // Owner strings look like "Priya Patel (Payments Data Lead, urn:li:corpuser:priya.patel)".
    const display = displayName(owner);
    return display.length > 2 && haystack.includes(display);
  });
}

/** "Priya Patel (Payments Data Lead, urn:...)" → "Priya Patel". */
export function displayName(owner: string): string {
  return owner.split("(")[0].trim();
}

/**
 * The owner strings worth showing a person.
 *
 * A snapshot's `owners` holds every identity DataHub offers for each owner —
 * display name, username, email, URN — because matching "ping Mike Rodriguez"
 * against a live catalog needs all of them. Printing all of them back gives you
 * "Priya Patel, priya.patel@northbeam.io, urn:li:corpuser:priya.patel", which
 * names one person three times. Keep the human-readable ones.
 */
export function humanOwners(owners: string[]): string[] {
  const names = owners.map(displayName).filter((o) => o && !o.includes("@") && !o.startsWith("urn:"));
  // Prefer "Mike Rodriguez" over "mike.rodriguez" when the catalog gives both.
  const spaced = names.filter((n) => n.includes(" "));
  const pool = spaced.length ? spaced : names;
  return [...new Set(pool)];
}

/* ── Claim extraction ─────────────────────────────────────────────────── */

/** Stable across runs and machines, so a claim can be referenced from a DataHub incident. */
function claimId(runbookId: string, stepIndex: number, kind: string, subject: string): string {
  return `${kind}:${hash([runbookId, stepIndex, kind, subject.toLowerCase()])}`;
}

/**
 * Break a runbook into the individual catalog assertions it makes.
 *
 * Derived from the baseline snapshot where there is one, because the baseline is
 * what the author actually saw. Where there isn't (runbooks written before
 * snapshotting shipped), fall back to live state, which still yields real claims
 * — they just carry a pin dated today rather than a historical one.
 */
export function extractClaims(
  runbook: { id: string; steps: HandoffStep[] },
  baseline: Record<string, EntitySnapshot>,
  live: Record<string, EntitySnapshot> = {}
): RunbookClaim[] {
  const claims: RunbookClaim[] = [];

  runbook.steps.forEach((step, stepIndex) => {
    if (!step.urn) return;
    const source = baseline[step.urn]?.exists ? baseline[step.urn] : live[step.urn];
    if (!source?.exists) return;

    const where = { stepIndex, stepTitle: step.title, urn: step.urn };
    const name = source.name ?? step.urn;
    const add = (kind: RunbookClaim["kind"], subject: string, statement: string, aspect: AspectName) =>
      claims.push({
        id: claimId(runbook.id, stepIndex, kind, subject),
        ...where,
        kind,
        subject,
        statement,
        validatedAgainst: pin(source, aspect),
      });

    add("entity-exists", step.urn, `${name} is in the catalog.`, "schema");

    for (const field of source.fields) {
      if (!stepReferences(step, field)) continue;
      add("column-exists", field, `${name} has a column \`${field}\`, which this step reads.`, "schema");
    }

    add("not-deprecated", step.urn, `${name} is not deprecated.`, "deprecation");

    if (source.openIncidents === 0 && source.failingAssertions === 0) {
      add("healthy", step.urn, `${name} has no open incidents and no failing assertions.`, "health");
    }

    for (const owner of ownersNamedIn(step, source.owners)) {
      const display = displayName(owner);
      add("owner-current", display, `${display} owns ${name}, and is who this step says to contact.`, "ownership");
    }
  });

  return claims;
}

/* ── Claim verification ───────────────────────────────────────────────── */

/**
 * Can this catalog answer "is this dataset healthy?" at all?
 *
 * DataHub's health signal is assertions plus incidents. On a dataset with
 * neither defined, `0 failing assertions` is true and means nothing — nobody is
 * checking, so nothing can fail. Treating that as a claim that holds is how a
 * runbook gets a clean bill of health from a catalog that was never asked.
 *
 * An open incident counts as observability on its own: somebody is watching.
 */
export function healthObservable(snapshot: EntitySnapshot): boolean {
  if (snapshot.openIncidents > 0 || snapshot.failingAssertions > 0) return true;
  return (snapshot.assertionCount ?? 0) > 0;
}

/**
 * Can this catalog answer "does this column still exist?"
 *
 * An entity DataHub knows about but holds no schema for — a common state for
 * datasets ingested without a schema crawler — cannot answer. Before this check,
 * an empty live field list read as "every column the runbook names has been
 * dropped", which is the loudest possible false positive.
 */
export function schemaObservable(snapshot: EntitySnapshot): boolean {
  return snapshot.fields.length > 0;
}

function ownerStillListed(display: string, owners: string[]): boolean {
  // Live DataHub renders owners as usernames ("mike.rodriguez"), snapshots may
  // hold display names ("Mike Rodriguez") — compare normalized.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return owners.some((o) => norm(o).includes(norm(display)));
}

/**
 * Re-check every claim against the catalog as it stands now, and record what it
 * was checked against so the verdict can be audited later.
 *
 * `aspectUnchanged` is the cheap half of the answer: when the pinned aspect
 * version still matches, nothing that could affect the claim has moved since it
 * was recorded, and the claim holds without any further reasoning. That is the
 * common case, and it is the part a reviewer can verify in one line.
 */
export function verifyClaims(claims: RunbookClaim[], live: Record<string, EntitySnapshot>): ClaimVerdict[] {
  return claims.map((claim) => {
    const now = live[claim.urn];
    const aspect = claim.validatedAgainst?.aspect ?? "schema";

    if (!now) {
      return {
        claimId: claim.id,
        status: "unverified" as const,
        aspectUnchanged: false,
        detail: "The catalog could not be read for this entity, so the claim was not re-checked.",
      };
    }

    const checkedAgainst = pin(now, aspect);
    const aspectUnchanged = claim.validatedAgainst?.aspectVersion === checkedAgainst.aspectVersion;
    const base = { claimId: claim.id, checkedAgainst, aspectUnchanged };
    const held = (detail: string) => ({ ...base, status: "holds" as const, detail });
    const broke = (detail: string) => ({ ...base, status: "broken" as const, detail });
    const cannotTell = (detail: string) => ({ ...base, status: "unvalidatable" as const, detail });

    if (!now.exists) {
      return broke(`\`${claim.urn}\` is no longer in the catalog.`);
    }

    switch (claim.kind) {
      case "entity-exists":
        return held(`Still in the catalog as ${now.name ?? claim.urn}.`);
      case "column-exists":
        if (!schemaObservable(now)) {
          return cannotTell(
            `${now.name ?? claim.urn} is in the catalog but carries no schema, so whether ` +
              `\`${claim.subject}\` still exists could not be checked.`
          );
        }
        return now.fields.includes(claim.subject)
          ? held(`Column \`${claim.subject}\` is still on the schema.`)
          : broke(`Column \`${claim.subject}\` is gone from ${now.name ?? claim.urn}.`);
      case "not-deprecated":
        return now.deprecated
          ? broke(`${now.name ?? claim.urn} is now deprecated.`)
          : held(`${now.name ?? claim.urn} is still live.`);
      case "healthy":
        if (!healthObservable(now)) {
          return cannotTell(
            `${now.name ?? claim.urn} has no assertions and no incidents defined on it, so "healthy" ` +
              `cannot be told apart from "unmonitored". Nothing is checking this table.`
          );
        }
        return now.openIncidents > 0 || now.failingAssertions > 0
          ? broke(
              `${now.name ?? claim.urn} now has ${now.openIncidents} open incident(s) and ` +
                `${now.failingAssertions} failing assertion(s).`
            )
          : held("No open incidents, no failing assertions.");
      case "owner-current":
        return ownerStillListed(claim.subject, now.owners)
          ? held(`${claim.subject} still owns ${now.name ?? claim.urn}.`)
          : broke(
              `${claim.subject} no longer owns ${now.name ?? claim.urn} ` +
                `(now: ${humanOwners(now.owners).join(", ") || "nobody"}).`
            );
    }
  });
}

/* ── Coverage ─────────────────────────────────────────────────────────── */

/**
 * How much of this runbook the run was actually able to check.
 *
 * The failure mode this exists to close: a sweep reports "0 drift" and a reader
 * takes it as "the runbook is fine", when what happened is that three of its
 * steps point at datasets the catalog holds no schema, no owners and no monitors
 * for. Nothing drifted because nothing could be looked at. Coverage is tracked as
 * its own figure so those two outcomes can never share a headline.
 *
 * A gap is a property of the *catalog*, not of the runbook — it is the thing to
 * go and fix, and naming the dimension says how.
 */
export function coverageOf(
  steps: HandoffStep[],
  live: Record<string, EntitySnapshot>,
  claims: RunbookClaim[],
  verdicts: ClaimVerdict[]
): RevalidationCoverage {
  const verdictById = new Map(verdicts.map((v) => [v.claimId, v]));
  const stepRows: StepCoverage[] = [];

  steps.forEach((step, stepIndex) => {
    if (!step.urn) return;
    const now = live[step.urn];
    const mine = claims.filter((c) => c.stepIndex === stepIndex);
    const unvalidatable = mine.filter((c) => verdictById.get(c.id)?.status === "unvalidatable").length;
    const where = { stepIndex, stepTitle: step.title, urn: step.urn };

    if (!now || !now.exists) {
      // Either the entity is gone (a finding, reported separately) or the read
      // failed. Both leave this step unchecked, so neither may count as covered.
      stepRows.push({
        ...where,
        state: "unvalidatable",
        gaps: ["schema", "ownership", "health"],
        claimsTotal: mine.length,
        claimsUnvalidatable: mine.length,
        detail: "The entity could not be read from the catalog, so no claim about it was re-checked.",
      });
      return;
    }

    const gaps: CoverageDimension[] = [];
    if (!schemaObservable(now)) gaps.push("schema");
    if (now.owners.length === 0) gaps.push("ownership");
    if (!healthObservable(now)) gaps.push("health");

    const reasons: Record<CoverageDimension, string> = {
      schema: "the catalog holds no schema for it",
      ownership: "it has no owners, so a finding could not be routed to anybody",
      health: "it has no assertions or incidents, so nothing is monitoring it",
    };

    stepRows.push({
      ...where,
      state: gaps.length === 0 ? "validated" : "partial",
      gaps,
      claimsTotal: mine.length,
      claimsUnvalidatable: unvalidatable,
      detail:
        gaps.length === 0
          ? `Every claim this step makes was checked against ${now.name ?? step.urn}.`
          : `${now.name ?? step.urn}: ${gaps.map((g) => reasons[g]).join("; ")}.`,
    });
  });

  const stepsValidated = stepRows.filter((s) => s.state === "validated").length;
  const stepsPartial = stepRows.filter((s) => s.state === "partial").length;
  const stepsUnvalidatable = stepRows.filter((s) => s.state === "unvalidatable").length;
  const claimsUnvalidatable = verdicts.filter((v) => v.status === "unvalidatable").length;

  const gapUrns = [...new Set(stepRows.filter((s) => s.gaps.length > 0 && s.urn).map((s) => s.urn as string))];
  const uncovered = stepsPartial + stepsUnvalidatable;
  const summary =
    `${stepsValidated}/${stepRows.length} steps validated` +
    (uncovered
      ? `, ${uncovered} with catalog gaps (${[...new Set(stepRows.flatMap((s) => s.gaps))].join(", ")})`
      : "");

  return {
    stepsTotal: stepRows.length,
    stepsValidated,
    stepsPartial,
    stepsUnvalidatable,
    claimsTotal: verdicts.length,
    claimsChecked: verdicts.filter((v) => v.status === "holds" || v.status === "broken").length,
    claimsUnvalidatable,
    summary,
    steps: stepRows,
    gapUrns,
  };
}

/**
 * The headline verdict. Findings win; a run with no findings but incomplete
 * coverage is explicitly not a pass.
 */
export function verdictOf(findingCount: number, coverage: RevalidationCoverage): RunbookVerdict {
  if (findingCount > 0) return "FINDING";
  if (coverage.claimsUnvalidatable > 0 || coverage.stepsUnvalidatable > 0) return "INSUFFICIENT_DATA";
  return "PASS";
}

/* ── Rendering the chain ──────────────────────────────────────────────── */

/**
 * One line of provenance, for an incident body or a note. Compressed on purpose:
 * this goes into surfaces where a data engineer is skimming, and the full record
 * is in the structured state written alongside it.
 */
export function chainLine(claim: RunbookClaim, verdict: ClaimVerdict): string {
  const from = claim.validatedAgainst;
  const arrow = from
    ? `${from.aspect}@${from.aspectVersion} (${from.at.slice(0, 10)}) → ${
        verdict.checkedAgainst ? `${verdict.checkedAgainst.aspect}@${verdict.checkedAgainst.aspectVersion}` : "unreadable"
      }`
    : "unpinned (runbook predates snapshotting)";
  // `~` rather than `?`: the catalog answered, it just could not answer this.
  const MARK: Record<ClaimVerdict["status"], string> = {
    holds: "✓",
    broken: "✗",
    unvalidatable: "~",
    unverified: "?",
  };
  const mark = MARK[verdict.status];
  return `${mark} step ${claim.stepIndex + 1} · ${claim.statement} — ${arrow}`;
}
