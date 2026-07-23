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
