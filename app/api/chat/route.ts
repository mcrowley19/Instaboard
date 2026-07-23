import { agentStreamResponse, llmConfigFromRequest } from "@/lib/agent";
import { CHAT_SYSTEM_PROMPT } from "@/lib/prompts";
import type { ChatMessage } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const config = llmConfigFromRequest(req);
  if (!config) {
    return Response.json(
      { error: "No LLM configured. Add an API key in Settings (gear icon) or set LLM_PROVIDER / LLM_API_KEY in .env.local." },
      { status: 401 }
    );
  }

  const body = (await req.json()) as { messages?: ChatMessage[] };
  const messages = (body.messages ?? []).filter((m) => m.content?.trim());
  if (messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }

  return agentStreamResponse(config, CHAT_SYSTEM_PROMPT, messages.slice(-20));
}
