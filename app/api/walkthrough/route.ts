export { corsPreflight as OPTIONS } from "@/lib/cors";
import { agentStreamResponse, llmConfigFromRequest } from "@/lib/agent";
import { walkthroughSystemPrompt } from "@/lib/prompts";
import type { RecordedStep } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Trainer mode: turn a recorded DataHub browsing trail into a teachable
 * walkthrough. The agent enriches every step via the DataHub MCP tools
 * before writing the plan, so instructions cite real owners/tags/queries.
 */
export async function POST(req: Request) {
  const config = llmConfigFromRequest(req);
  if (!config) {
    return Response.json(
      { error: "No LLM configured. Set LLM_PROVIDER / LLM_API_KEY in .env.local (required for the Chrome extension)." },
      { status: 401 }
    );
  }

  const body = (await req.json()) as { title?: string; goal?: string; steps?: RecordedStep[] };
  const steps = (body.steps ?? []).filter((s) => s.urn || s.note || s.title);
  if (steps.length === 0) {
    return Response.json({ error: "steps is required — record at least one DataHub page visit" }, { status: 400 });
  }

  const trail = steps
    .map((s, i) => {
      const parts = [`${i + 1}. ${s.title || s.url || "page"}`];
      if (s.urn) parts.push(`   entity: ${s.urn} (${s.entityType ?? "unknown type"})`);
      if (s.selection) parts.push(`   trainer highlighted: "${s.selection.slice(0, 500)}"`);
      if (s.note) parts.push(`   trainer's note: "${s.note.slice(0, 1000)}"`);
      return parts.join("\n");
    })
    .join("\n");

  const intro = [
    body.title ? `The trainer titled this task: "${body.title}".` : "",
    body.goal ? `The trainer described the goal as: "${body.goal}".` : "",
    "Here is the recorded trail of their DataHub session, in order:",
    "",
    trail,
    "",
    "Enrich these entities with the DataHub tools, then output the walkthrough JSON.",
  ]
    .filter(Boolean)
    .join("\n");

  return agentStreamResponse(config, walkthroughSystemPrompt(), [{ role: "user", content: intro }]);
}
