import { agentStreamResponse, llmConfigFromRequest } from "@/lib/agent";
import { learningPathSystemPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const config = llmConfigFromRequest(req);
  if (!config) {
    return Response.json(
      { error: "No LLM configured. Add an API key in Settings first." },
      { status: 401 }
    );
  }

  const body = (await req.json()) as { role?: string; domain?: string };
  const role = body.role?.trim() || "Junior Data Analyst";
  const domain = body.domain?.trim() || "Payments";

  return agentStreamResponse(config, learningPathSystemPrompt(role, domain), [
    {
      role: "user",
      content: `Build the Week-1 learning path for a new ${role} in the ${domain} domain. Explore the catalog first, then output the JSON plan.`,
    },
  ]);
}
