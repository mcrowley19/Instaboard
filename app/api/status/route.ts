import { mcpStatus } from "@/lib/mcp";

export const runtime = "nodejs";

export async function GET() {
  const status = await mcpStatus();
  return Response.json(status);
}
