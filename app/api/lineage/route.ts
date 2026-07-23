import { agentStreamResponse, llmConfigFromRequest } from "@/lib/agent";
import { callDataHubTool } from "@/lib/mcp";
import { lineageSystemPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET  /api/lineage?q=...    → search datasets (raw MCP search, no LLM)
 * POST /api/lineage {urn}    → raw lineage graph + streamed LLM explanation
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) return Response.json({ error: "q is required" }, { status: 400 });

  const result = await callDataHubTool("search", { query: q, num_results: 10 });
  if (result.isError) {
    return Response.json({ error: result.content }, { status: 502 });
  }
  return Response.json({ raw: result.content });
}

export async function POST(req: Request) {
  const config = llmConfigFromRequest(req);
  if (!config) {
    return Response.json(
      { error: "No LLM configured. Add an API key in Settings first." },
      { status: 401 }
    );
  }

  const body = (await req.json()) as { urn?: string };
  if (!body.urn) {
    return Response.json({ error: "urn is required" }, { status: 400 });
  }

  return agentStreamResponse(config, lineageSystemPrompt(), [
    {
      role: "user",
      content: `Explain the lineage of \`${body.urn}\` for a new hire. Fetch upstream and downstream lineage, entity details, and sample queries before writing.`,
    },
  ]);
}
