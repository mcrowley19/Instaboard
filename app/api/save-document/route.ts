export { corsPreflight as OPTIONS } from "@/lib/cors";
import { callDataHubTool } from "@/lib/mcp";
import { walkthroughMarkdown } from "@/lib/prompts";
import type { Walkthrough } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Write-back: persist an onboarding note / learning path to DataHub via the
 * MCP server's save_document tool, so the next hire finds it in the catalog.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    title?: string;
    content?: string;
    documentType?: string;
    topics?: string[];
    walkthrough?: Walkthrough;
  };

  // Trainer mode sends the generated walkthrough object; render it server-side
  // so the extension stays a thin client.
  if (body.walkthrough?.title && body.walkthrough.steps?.length) {
    body.title ??= body.walkthrough.title;
    body.content ??= walkthroughMarkdown(body.walkthrough);
    body.topics ??= ["training", "walkthrough"];
  }

  if (!body.title || !body.content) {
    return Response.json({ error: "title and content are required" }, { status: 400 });
  }

  const result = await callDataHubTool("save_document", {
    // One of the MCP server's supported document subtypes.
    document_type: body.documentType ?? "Note",
    title: body.title,
    content: body.content,
    topics: body.topics?.length ? body.topics : ["onboarding"],
  });

  if (result.isError) {
    return Response.json({ error: result.content }, { status: 502 });
  }
  return Response.json({ ok: true, result: result.content });
}
