// Alias so the extension (and docs) can use the more explicit path name.
export { POST } from "../path/route";
export { corsPreflight as OPTIONS } from "@/lib/cors";

export const runtime = "nodejs";
export const maxDuration = 300;
