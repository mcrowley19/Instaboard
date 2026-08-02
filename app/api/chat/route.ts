import { agentStreamResponse, llmConfigFromRequest } from "@/lib/agent";
import { CHAT_SYSTEM_PROMPT, pageContextBlock } from "@/lib/prompts";
import { findReplayTurn, replayQuestions, replayStreamResponse } from "@/lib/replay";
import type { ChatRequestBody } from "@/lib/types";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
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

  const config = llmConfigFromRequest(req);

  // No key anywhere? Fall back to a committed recording of a real session, so
  // the hosted demo works on arrival instead of opening with a key prompt.
  if (!config) {
    const question = messages[messages.length - 1].content;
    const turn = findReplayTurn(question);
    if (turn) return replayStreamResponse(turn);

    return Response.json(
      {
        error:
          "No LLM configured, and that question isn't in the recorded demo session. " +
          "Add an API key in Settings to ask anything, or try one of the recorded questions.",
        replayQuestions: replayQuestions(),
      },
      { status: 401 }
    );
  }

  const system = CHAT_SYSTEM_PROMPT + pageContextBlock(body.context);
  return agentStreamResponse(config, system, messages.slice(-20));
}
