export { corsPreflight as OPTIONS } from "@/lib/cors";
import { callDataHubTool } from "@/lib/mcp";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Trainee mode: list training walkthroughs stored in the DataHub catalog
 * (GET), or fetch one by URN (GET ?urn=...). Walkthroughs are documents
 * saved via save_document with the "training" topic, so they are ordinary
 * catalog citizens — visible in DataHub itself, not just in instaboard.
 */

/** Recursively collect document-like objects from an arbitrary tool result. */
function collectDocuments(node: unknown, out: Map<string, { urn: string; title: string }>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDocuments(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const urn = typeof obj.urn === "string" ? obj.urn : undefined;
  if (urn && urn.startsWith("urn:li:document")) {
    const title = [obj.title, obj.name, obj.id].find((v): v is string => typeof v === "string") ?? urn;
    if (!out.has(urn)) out.set(urn, { urn, title });
  }
  for (const value of Object.values(obj)) collectDocuments(value, out);
}

/** Recursively find the longest string under content/text/markdown keys. */
function findContent(node: unknown): string {
  if (Array.isArray(node)) {
    return node.map(findContent).reduce((a, b) => (b.length > a.length ? b : a), "");
  }
  if (!node || typeof node !== "object") return "";
  let best = "";
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "string" && ["content", "text", "markdown", "documentation"].includes(key)) {
      if (value.length > best.length) best = value;
    } else if (typeof value === "object" && value !== null) {
      const nested = findContent(value);
      if (nested.length > best.length) best = nested;
    }
  }
  return best;
}

function parseToolJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const urn = new URL(req.url).searchParams.get("urn");

  if (urn) {
    const result = await callDataHubTool("get_entities", { urns: [urn] });
    if (result.isError) return Response.json({ error: result.content }, { status: 502 });
    const parsed = parseToolJson(result.content);
    const content = parsed ? findContent(parsed) : result.content;
    if (!content) return Response.json({ error: "Document has no content" }, { status: 404 });
    return Response.json({ urn, content });
  }

  const result = await callDataHubTool("search", {
    query: "training walkthrough",
    entity_type: "document",
  });
  if (result.isError) return Response.json({ error: result.content }, { status: 502 });

  const docs = new Map<string, { urn: string; title: string }>();
  const parsed = parseToolJson(result.content);
  if (parsed) collectDocuments(parsed, docs);
  return Response.json({ walkthroughs: [...docs.values()] });
}
