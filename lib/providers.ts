import Anthropic from "@anthropic-ai/sdk";
import type { AgentTurn, LLMConfig, LLMTurn, ToolDef } from "./types";

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-4-8",
  openrouter: "anthropic/claude-sonnet-4.5",
  gemini: "gemini-2.5-flash",
};

const MAX_ATTEMPTS = Number(process.env.LLM_MAX_ATTEMPTS || 5);

/**
 * A 200 response whose `choices` array is empty. Free tiers return this under
 * load part-way through a multi-call tool loop, and it is the single failure
 * that invalidated the first held-out run: 10 of 18 grounded cases died on it
 * while the zero-tool control arm, making one request per case, sailed past.
 * Treating it as terminal turned a provider hiccup into a measurement.
 */
export class EmptyCompletion extends Error {}

/** Rate limits and provider hiccups are transient — retry them, don't surface them. */
function isRetryable(err: unknown): boolean {
  if (err instanceof EmptyCompletion) return true;
  const status = (err as { status?: number })?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|rate.?limit|overloaded|timeout|ECONNRESET|fetch failed|no choices/i.test(message);
}

/**
 * A hard spend limit or exhausted daily quota is NOT transient — retrying just
 * burns minutes to arrive at the same refusal. Fail fast and say why.
 *
 * The 429 case matters as much as the 402/403 one and is easy to get wrong,
 * because a per-day cap and a per-minute cap arrive as the same status code. A
 * per-minute cap is worth backing off for; a per-day cap is not, and treating it
 * as transient means every remaining case burns its full retry ladder and then
 * records an error. That produces a scorecard full of zeros that look like a
 * model failing when they are a quota resetting at midnight — exactly the way
 * the first held-out run was ruined. OpenRouter names the daily one in the
 * refusal, so match on that rather than on the status.
 */
export function isQuotaExhausted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/free-models-per-day|_free_tier_daily|per-day|daily limit|quota exceeded for the day/i.test(message)) {
    return true;
  }
  return /\b40[23]\b/.test(message) && /limit exceeded|quota|insufficient|billing|credit/i.test(message);
}

/** Providers tell us how long to wait — honour it rather than guessing. */
function retryAfterMs(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const seconds = message.match(/retry[- ]after["':\s]+(\d+)/i)?.[1];
  return seconds ? Number(seconds) * 1000 : null;
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
      // Out of quota is terminal — don't spend minutes rediscovering that.
      if (isQuotaExhausted(err)) throw err;
      if (attempt === MAX_ATTEMPTS - 1 || !isRetryable(err)) throw err;
      // Honour Retry-After when given; otherwise 2s, 4s, 8s, 16s with jitter.
      // Free tiers meter per minute, so the backoff has to reach past 60s.
      await sleep(retryAfterMs(err) ?? 2 ** (attempt + 1) * 1000 + Math.random() * 1000);
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
  // A request that never returns stalls the whole pool behind it. Free-tier
  // providers do occasionally hang; time out and let the retry loop have it.
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 180_000)),
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
    error?: { message?: string; code?: number };
    choices?: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  };

  // OpenRouter reports upstream failures inside a 200 body as often as it does
  // with a status code, so the status alone is not the health check.
  if (data.error) {
    const detail = `${config.provider} upstream error ${data.error.code ?? ""}: ${data.error.message ?? ""}`.trim();
    if (isQuotaExhausted(new Error(`${data.error.code ?? 403} ${data.error.message ?? ""}`))) throw new Error(detail);
    throw new EmptyCompletion(detail);
  }

  const message = data.choices?.[0]?.message;
  if (!message) throw new EmptyCompletion(`${config.provider} returned no choices`);

  // A turn with neither text nor a tool call ends the agent loop holding
  // nothing. That is the same dropped response wearing a different shape.
  if (!message.content?.trim() && !message.tool_calls?.length) {
    throw new EmptyCompletion(`${config.provider} returned an empty message`);
  }

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
