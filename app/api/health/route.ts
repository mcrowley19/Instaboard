export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ ok: true, service: "instaboard", time: new Date().toISOString() });
}
