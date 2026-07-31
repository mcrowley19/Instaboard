import { llmConfigFromRequest, runAgent } from "@/lib/agent";
import { snapshotHandoff } from "@/lib/decay";
import { handoffToMarkdown, listHandoffs, newHandoffId, saveHandoff } from "@/lib/handoff-store";
import { callDataHubTool } from "@/lib/mcp";
import { handoffSystemPrompt } from "@/lib/prompts";
import type { AgentEvent, CreateHandoffBody, Handoff, HandoffStep } from "@/lib/types";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  return Response.json({ handoffs: listHandoffs() });
}

function extractRunbook(text: string): { title?: string; summary?: string; steps?: HandoffStep[] } | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = matches.length ? matches[matches.length - 1][1] : text;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Create a handoff: take the extension's recorded trail, have the agent
 * enrich every step from the live catalog, persist it, and write it back to
 * DataHub via save_document. Streams NDJSON so the recorder shows progress;
 * the final `result` event carries the saved handoff.
 */
export async function POST(req: Request) {
  const config = llmConfigFromRequest(req);
  if (!config) {
    return Response.json(
      { error: "No LLM configured. Set LLM_PROVIDER / LLM_API_KEY in .env.local." },
      { status: 401 }
    );
  }

  const body = (await req.json()) as CreateHandoffBody;
  const recorded = (body.steps ?? []).filter((s) => s.url);
  if (recorded.length === 0) {
    return Response.json({ error: "steps is required — record at least one page" }, { status: 400 });
  }
  const title = body.title?.trim() || "Untitled handoff";
  const author = body.author?.trim() || "Unknown";

  const userMessage =
    `Task: "${title}" recorded by ${author}${body.role ? ` (${body.role})` : ""}.\n\nRecorded trail:\n` +
    recorded
      .map(
        (s, i) =>
          `${i + 1}. ${s.title || s.url}\n   url: ${s.url}` +
          (s.urn ? `\n   urn: ${s.urn}` : "") +
          (s.note ? `\n   author note: "${s.note}"` : "") +
          (s.selection ? `\n   text they highlighted: "${s.selection.slice(0, 500)}"` : "")
      )
      .join("\n") +
    "\n\nLook the entities up in DataHub, then produce the runbook JSON.";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const finalText = await runAgent(
          config,
          handoffSystemPrompt(),
          [{ role: "user", content: userMessage }],
          // Suppress raw text (it's just the JSON) — forward tool activity.
          (e) => {
            if (e.type !== "text" && e.type !== "done") emit(e);
          }
        );

        const runbook = extractRunbook(finalText);
        if (!runbook || !Array.isArray(runbook.steps) || runbook.steps.length === 0) {
          emit({ type: "error", message: "The agent did not return a valid runbook. Try again." });
          return;
        }

        // Baseline the catalog facts these steps depend on, so we can tell
        // later whether the runbook has gone stale (see lib/decay.ts).
        const snapshots = await snapshotHandoff(runbook.steps);

        const handoff: Handoff = {
          id: newHandoffId(title),
          title: runbook.title || title,
          author,
          role: body.role?.trim() || undefined,
          summary: runbook.summary || "",
          steps: runbook.steps,
          recorded,
          createdAt: new Date().toISOString(),
          snapshots,
        };

        // Write-back: the handoff lives in the DataHub catalog for the next hire.
        const doc = await callDataHubTool("save_document", {
          document_type: "Note",
          title: `Handoff: ${handoff.title}`,
          content: handoffToMarkdown(handoff),
          topics: ["onboarding", "handoff"],
          related_assets: handoff.steps.map((s) => s.urn).filter(Boolean).slice(0, 10),
        });
        handoff.datahub = {
          saved: !doc.isError,
          detail: doc.content.slice(0, 300),
        };

        saveHandoff(handoff);
        emit({ type: "result", data: handoff });
        emit({ type: "done" });
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
