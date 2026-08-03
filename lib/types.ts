export type Role = "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

/** Events streamed from the agent loop to the UI (newline-delimited JSON). */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: string; isError?: boolean }
  | { type: "result"; data: unknown }
  | { type: "done" }
  | { type: "error"; message: string };

export type ProviderName = "anthropic" | "openrouter" | "gemini";

export interface LLMConfig {
  provider: ProviderName;
  apiKey: string;
  model?: string;
}

/** Provider-neutral tool definition, mapped from MCP tool schemas. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One LLM turn: either a final text answer or a set of tool calls to run. */
export interface LLMTurn {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
}

/** Provider-neutral conversation item used inside the agent loop. */
export type AgentTurn =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }
  | { kind: "tool_results"; results: { id: string; name: string; content: string; isError?: boolean }[] };

/**
 * Page context captured by the Chrome extension while the user browses
 * DataHub. Sent alongside chat messages so answers can target the entity
 * on screen.
 */
export interface PageContext {
  url?: string;
  title?: string;
  datasetUrn?: string;
  entityType?: string;
  selection?: string;
}

/** Body accepted by /api/chat — web app sends `messages`, extension sends `message` (+ optional prior `messages`) and `context`. */
export interface ChatRequestBody {
  messages?: ChatMessage[];
  message?: string;
  context?: PageContext;
}

export interface LearningPathItem {
  title: string;
  detail: string;
  urn?: string;
}

export interface LearningPathDay {
  day: number;
  title: string;
  items: LearningPathItem[];
}

export interface LearningPath {
  role: string;
  domain: string;
  summary: string;
  days: LearningPathDay[];
  generatedAt?: string;
}

/* ── Handoffs: record a workflow in DataHub, inherit it step-by-step ───── */

/** One raw page visit captured by the extension while recording. */
export interface RecordedStep {
  url: string;
  title?: string;
  urn?: string;
  entityType?: string;
  note?: string;
  selection?: string;
  visitedAt?: string;
}

/** One step of the AI-enriched runbook the joiner replays. */
export interface HandoffStep {
  title: string;
  instruction: string;
  why: string;
  urn?: string;
  url?: string;
  tips?: string;
  sql?: string;
  /**
   * Where the `why` came from. `recorded` means a person said it, which is the
   * only kind of why worth having. `inferred` means it was derived from catalog
   * evidence by the drafter, and reads as evidence rather than as intent — a
   * drafted runbook must never impersonate a colleague's judgement.
   */
  whySource?: "recorded" | "inferred";
}

/** The catalog aspects a runbook claim can be pinned to. */
export type AspectName = "schema" | "ownership" | "deprecation" | "health";

/**
 * A content fingerprint of one entity as a runbook sees it. Computed from public
 * catalog facts, so anybody with the runbook and a DataHub connection can
 * recompute it and check that a pin is honest. See `lib/provenance.ts`.
 */
export interface EntityVersion {
  /** Moves if any aspect below moves. */
  entity: string;
  /** Per-aspect, so drift can be attributed to the exact aspect that changed. */
  aspects: Record<AspectName, string>;
}

/**
 * The catalog facts a runbook step leaned on, captured when it was written.
 * Re-reading these later is how instaboard knows a runbook has gone stale.
 */
export interface EntitySnapshot {
  urn: string;
  name?: string;
  exists: boolean;
  fields: string[];
  owners: string[];
  /** Owner URNs specifically — needed to assign a DataHub incident to a person. */
  ownerUrns?: string[];
  deprecated: boolean;
  /** DataHub's deprecation note, which usually names the replacement dataset. */
  deprecationNote?: string;
  openIncidents: number;
  failingAssertions: number;
  /**
   * How many assertions are defined on this entity at all, excluding the ones
   * instaboard writes itself. Zero failing assertions means "healthy" only if
   * something is actually being asserted; on an unmonitored dataset it means
   * nobody is looking. Deliberately *not* part of the fingerprint — adding a
   * monitor to a table is not drift in a runbook that reads it.
   *
   * `undefined` means it was not determined, which is treated the same as zero:
   * we could not establish that health is observable.
   */
  assertionCount?: number;
  capturedAt: string;
  /** Optional: runbooks recorded before provenance shipped have no version. */
  version?: EntityVersion;
}

/** The kinds of individually checkable assertion a runbook step makes. */
export type ClaimKind = "entity-exists" | "column-exists" | "not-deprecated" | "healthy" | "owner-current";

/** Which version of which aspect of which entity a claim was checked against. */
export interface ClaimPin {
  urn: string;
  aspect: AspectName;
  aspectVersion: string;
  entityVersion: string;
  at: string;
}

/** One catalog assertion a runbook step makes, pinned to the state that backed it. */
export interface RunbookClaim {
  id: string;
  stepIndex: number;
  stepTitle: string;
  urn: string;
  kind: ClaimKind;
  /** The column name, owner display name, or URN the claim is about. */
  subject: string;
  statement: string;
  validatedAgainst?: ClaimPin;
}

/**
 * What re-checking one claim concluded.
 *
 * `unvalidatable` is the state that stops a clean report from lying. A claim that
 * the catalog holds no evidence either way for — "no failing assertions" on a
 * dataset nobody monitors, "the column is still there" on a dataset whose schema
 * never ingested — is not a claim that holds. Collapsing it into `holds` is how a
 * runbook comes back 17/17 green on a catalog that could not answer the question.
 *
 * `unverified` is different and narrower: the catalog could not be read at all.
 */
export type ClaimStatus = "holds" | "broken" | "unvalidatable" | "unverified";

export interface ClaimVerdict {
  claimId: string;
  status: ClaimStatus;
  /** The version this re-check ran against — the far end of the provenance chain. */
  checkedAgainst?: ClaimPin;
  /** True when the pinned aspect has not moved at all since the claim was recorded. */
  aspectUnchanged: boolean;
  detail: string;
}

export type DecaySeverity = "ok" | "warning" | "broken";

export type DecayKind =
  | "entity-missing"
  | "column-missing"
  | "newly-deprecated"
  | "deprecated"
  | "new-incident"
  | "failing-assertion"
  | "owner-changed";

export interface DecayFinding {
  stepIndex: number;
  stepTitle: string;
  urn: string;
  severity: DecaySeverity;
  kind: DecayKind;
  detail: string;
  remedy?: string;
  /** The claim this finding broke, linking the finding to its provenance chain. */
  claimId?: string;
}

/**
 * The three things a validation run can conclude, kept separate from severity.
 *
 * `severity` answers "how bad is what we found". `verdict` answers the prior
 * question: did we find anything, and were we able to look?
 *
 *   PASS               every claim was checked and every claim holds.
 *   FINDING            something concrete drifted. See `findings`.
 *   INSUFFICIENT_DATA  nothing drifted among the claims we could check, but the
 *                      catalog could not answer for all of them. Not a clean run.
 *
 * FINDING outranks INSUFFICIENT_DATA: a run that both found drift and had gaps
 * reports the drift, with the gaps still recorded in `coverage`.
 */
export type RunbookVerdict = "PASS" | "FINDING" | "INSUFFICIENT_DATA";

/** The kinds of catalog evidence a claim can be checked against. */
export type CoverageDimension = "schema" | "ownership" | "health";

export interface StepCoverage {
  stepIndex: number;
  stepTitle: string;
  urn?: string;
  /** `validated` = every claim this step makes was actually checked. */
  state: "validated" | "partial" | "unvalidatable";
  /** Dimensions the catalog held no evidence for, so nothing could be concluded. */
  gaps: CoverageDimension[];
  claimsTotal: number;
  claimsUnvalidatable: number;
  detail: string;
}

/**
 * How much of the runbook this run was actually able to check.
 *
 * Published alongside the result, and written into DataHub as a structured
 * property, because a coverage figure nobody can see turns back into the thing
 * it exists to prevent.
 */
export interface RevalidationCoverage {
  stepsTotal: number;
  stepsValidated: number;
  stepsPartial: number;
  stepsUnvalidatable: number;
  claimsTotal: number;
  claimsChecked: number;
  claimsUnvalidatable: number;
  /** "14/17 steps validated" — the headline, and the structured-property value. */
  summary: string;
  steps: StepCoverage[];
  /** Datasets carrying at least one gap, for the tag write-back. */
  gapUrns: string[];
}

export interface DecayReport {
  handoffId: string;
  checkedAt: string;
  severity: DecaySeverity;
  /** Optional for reports stored before the three-state verdict shipped. */
  verdict?: RunbookVerdict;
  /** What this run could and could not check. Optional for the same reason. */
  coverage?: RevalidationCoverage;
  stepsChecked: number;
  entitiesChecked: number;
  /** False for runbooks written before snapshotting — absolute checks only. */
  hadSnapshot: boolean;
  findings: DecayFinding[];
  /** Every catalog assertion the runbook makes, pinned to what backed it. */
  claims?: RunbookClaim[];
  /** The re-check of each claim against the catalog as of `checkedAt`. */
  verdicts?: ClaimVerdict[];
  /** The entity versions this run read, keyed by URN — the far end of each chain. */
  versions?: Record<string, EntityVersion>;
}

export interface Handoff {
  id: string;
  title: string;
  author: string;
  role?: string;
  summary: string;
  steps: HandoffStep[];
  recorded: RecordedStep[];
  createdAt: string;
  sample?: boolean;
  /** `drafted` runbooks were derived from catalog evidence with nobody recording. */
  source?: "recorded" | "drafted";
  /** For drafts: what evidence the catalog held, shown to whoever reviews it. */
  draftBasis?: string[];
  datahub?: { saved: boolean; detail?: string };
  /** Catalog state at record time, keyed by URN — the decay baseline. */
  snapshots?: Record<string, EntitySnapshot>;
  /** Result of the most recent validation run against live DataHub. */
  decay?: DecayReport;
}

export interface CreateHandoffBody {
  title?: string;
  author?: string;
  role?: string;
  steps?: RecordedStep[];
}
