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
  deprecated: boolean;
  openIncidents: number;
  failingAssertions: number;
  capturedAt: string;
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
}

export interface DecayReport {
  handoffId: string;
  checkedAt: string;
  severity: DecaySeverity;
  stepsChecked: number;
  entitiesChecked: number;
  /** False for runbooks written before snapshotting — absolute checks only. */
  hadSnapshot: boolean;
  findings: DecayFinding[];
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
