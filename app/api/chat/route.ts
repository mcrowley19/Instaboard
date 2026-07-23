import { agentStreamResponse, llmConfigFromRequest } from "@/lib/agent";
import { CHAT_SYSTEM_PROMPT, pageContextBlock } from "@/lib/prompts";
import type { ChatRequestBody } from "@/lib/types";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const config = llmConfigFromRequest(req);
  if (!config) {
    return Response.json(
      { error: "No LLM configured. Add an API key in the web app Settings, or set LLM_PROVIDER / LLM_API_KEY in .env.local (required for the Chrome extension)." },
      { status: 401 }
    );
  }

  const body = (await req.json()) as ChatRequestBody;

  // Web app sends full `messages`; the extension sends the latest `message`
  // (plus optional prior history) and page `context`.
  let messages = (body.messages ?? []).filter((m) => m.content?.trim());
  if (body.message?.trim()) {
    messages = [...messages, { role: "user", content: body.message.trim() }];
  }
  if (messages.length === 0) {
    return Response.json({ error: "message or messages is required" }, { status: 400 });
  }

  const system = CHAT_SYSTEM_PROMPT + pageContextBlock(body.context);
  return agentStreamResponse(config, system, messages.slice(-20));
}
