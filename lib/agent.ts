import { callDataHubTool, listDataHubTools } from "./mcp";
import { runLLMTurn } from "./providers";
import type { AgentEvent, AgentTurn, ChatMessage, LLMConfig } from "./types";

const MAX_ITERATIONS = 10;

/**
 * The agent loop: hand the LLM the DataHub MCP tool set, execute every tool
 * call it makes against the real DataHub instance, and feed results back
 * until it produces a final answer. Emits UI events along the way.
 */
export async function runAgent(
  config: LLMConfig,
  system: string,
  history: ChatMessage[],
  emit: (event: AgentEvent) => void
): Promise<string> {
  const tools = await listDataHubTools();

  const turns: AgentTurn[] = history.map((m) =>
    m.role === "user"
      ? { kind: "user", content: m.content }
      : { kind: "assistant", content: m.content, toolCalls: [] }
  );

  let finalText = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const turn = await runLLMTurn(config, system, turns, tools);

    if (turn.text) {
      emit({ type: "text", text: turn.text });
      finalText = turn.text;
    }

    if (turn.toolCalls.length === 0) break;

    turns.push({ kind: "assistant", content: turn.text, toolCalls: turn.toolCalls });

    // Execute all requested tool calls in parallel against DataHub.
    const results = await Promise.all(
      turn.toolCalls.map(async (call) => {
        emit({ type: "tool_call", id: call.id, name: call.name, args: call.args });
        const result = await callDataHubTool(call.name, call.args);
        emit({
          type: "tool_result",
          id: call.id,
          name: call.name,
          result: result.content.slice(0, 4000),
          isError: result.isError,
        });
        return { id: call.id, name: call.name, content: result.content, isError: result.isError };
      })
    );

    turns.push({ kind: "tool_results", results });
  }

  emit({ type: "done" });
  return finalText;
}

/** Wrap the agent loop in a newline-delimited-JSON streaming Response. */
export function agentStreamResponse(
  config: LLMConfig,
  system: string,
  history: ChatMessage[]
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        await runAgent(config, system, history, emit);
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Read LLM config from request headers, falling back to server env vars. */
export function llmConfigFromRequest(req: Request): LLMConfig | null {
  const provider =
    (req.headers.get("x-llm-provider") as LLMConfig["provider"]) ||
    (process.env.LLM_PROVIDER as LLMConfig["provider"]) ||
    null;
  const apiKey = req.headers.get("x-llm-key") || process.env.LLM_API_KEY || null;
  const model = req.headers.get("x-llm-model") || process.env.LLM_MODEL || undefined;
  if (!provider || !apiKey) return null;
  return { provider, apiKey, model };
}
