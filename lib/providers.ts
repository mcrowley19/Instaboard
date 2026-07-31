import Anthropic from "@anthropic-ai/sdk";
import type { AgentTurn, LLMConfig, LLMTurn, ToolDef } from "./types";

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-4-8",
  openrouter: "anthropic/claude-sonnet-4.5",
  gemini: "gemini-2.5-flash",
};

const MAX_ATTEMPTS = 4;

/** Rate limits and provider hiccups are transient — retry them, don't surface them. */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|rate.?limit|overloaded|timeout|ECONNRESET|fetch failed/i.test(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one LLM turn: given the conversation so far and the DataHub tool set,
 * return either a final text answer or a batch of tool calls to execute.
 * Retries transient provider failures with exponential backoff and jitter.
 */
export async function runLLMTurn(
  config: LLMConfig,
  system: string,
  turns: AgentTurn[],
  tools: ToolDef[]
): Promise<LLMTurn> {
  const model = config.model || DEFAULT_MODELS[config.provider];

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return config.provider === "anthropic"
        ? await anthropicTurn(config.apiKey, model, system, turns, tools)
        : await openAICompatTurn(config, model, system, turns, tools);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS - 1 || !isRetryable(err)) throw err;
      // 1s, 2s, 4s — plus jitter so parallel callers don't retry in lockstep.
      await sleep(2 ** attempt * 1000 + Math.random() * 500);
    }
  }
  throw lastError;
}

/* ── Anthropic (official SDK) ─────────────────────────────────────────── */

function toAnthropicMessages(turns: AgentTurn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    if (turn.kind === "user") {
      messages.push({ role: "user", content: turn.content });
    } else if (turn.kind === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (turn.content) content.push({ type: "text", text: turn.content });
      for (const call of turn.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
    } else {
      messages.push({
        role: "user",
        content: turn.results.map(
          (r): Anthropic.ToolResultBlockParam => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
            is_error: r.isError,
          })
        ),
      });
    }
  }
  return messages;
}

async function anthropicTurn(
  apiKey: string,
  model: string,
  system: string,
  turns: AgentTurn[],
  tools: ToolDef[]
): Promise<LLMTurn> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: toAnthropicMessages(turns),
    tools: tools.map(
      (t): Anthropic.Tool => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })
    ),
  });

  const turn: LLMTurn = { text: "", toolCalls: [] };
  for (const block of response.content) {
    if (block.type === "text") {
      turn.text += block.text;
    } else if (block.type === "tool_use") {
      turn.toolCalls.push({
        id: block.id,
        name: block.name,
        args: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return turn;
}

/* ── OpenAI-compatible (OpenRouter, Gemini) ───────────────────────────── */

const OPENAI_COMPAT_ENDPOINTS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
};

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toOAIMessages(system: string, turns: AgentTurn[]): OAIMessage[] {
  const messages: OAIMessage[] = [{ role: "system", content: system }];
  for (const turn of turns) {
    if (turn.kind === "user") {
      messages.push({ role: "user", content: turn.content });
    } else if (turn.kind === "assistant") {
      messages.push({
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.length
          ? turn.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            }))
          : undefined,
      });
    } else {
      for (const r of turn.results) {
        messages.push({ role: "tool", content: r.content, tool_call_id: r.id });
      }
    }
  }
  return messages;
}

async function openAICompatTurn(
  config: LLMConfig,
  model: string,
  system: string,
  turns: AgentTurn[],
  tools: ToolDef[]
): Promise<LLMTurn> {
  const endpoint = OPENAI_COMPAT_ENDPOINTS[config.provider];
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...(config.provider === "openrouter"
        ? { "HTTP-Referer": "https://github.com/instaboard", "X-Title": "instaboard" }
        : {}),
    },
    body: JSON.stringify({
      model,
      messages: toOAIMessages(system, turns),
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${config.provider} API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error(`${config.provider} returned no choices`);

  return {
    text: message.content ?? "",
    toolCalls: (message.tool_calls ?? []).map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.function.name,
      args: safeParseJSON(c.function.arguments),
    })),
  };
}

function safeParseJSON(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
