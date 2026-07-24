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

/**
 * One raw step captured by the extension while a trainer browses DataHub
 * in recording mode. The backend enriches these into a Walkthrough.
 */
export interface RecordedStep {
  url?: string;
  title?: string;
  urn?: string;
  entityType?: string;
  selection?: string;
  note?: string;
}

/** One teachable step of a generated walkthrough. */
export interface WalkthroughStep {
  order: number;
  title: string;
  urn?: string;
  entityType?: string;
  instruction: string;
  why: string;
  lookFor?: string;
}

/** A trainer-recorded task, enriched from the catalog, saved back to DataHub. */
export interface Walkthrough {
  title: string;
  goal: string;
  steps: WalkthroughStep[];
  quiz?: { question: string; answer: string }[];
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
