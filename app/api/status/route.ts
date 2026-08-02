export { corsPreflight as OPTIONS } from "@/lib/cors";
import { mcpStatus } from "@/lib/mcp";
import { replayQuestions } from "@/lib/replay";

export const runtime = "nodejs";

export async function GET() {
  const status = await mcpStatus();

  // When the server has no key of its own, the UI needs to know that answers
  // will come from the committed recording, and which questions it can serve, so
  // it can say so up front rather than after a failed request.
  const serverHasKey = Boolean(process.env.LLM_PROVIDER && process.env.LLM_API_KEY);
  const questions = replayQuestions();

  return Response.json({
    ...status,
    serverHasKey,
    ...(!serverHasKey && questions.length > 0 ? { replay: { questions } } : {}),
  });
}
