import { deleteHandoff, getHandoff } from "@/lib/handoff-store";

export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const handoff = getHandoff(id);
  if (!handoff) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(handoff);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const removed = deleteHandoff(id);
  return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
}
