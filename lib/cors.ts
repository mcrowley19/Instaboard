/**
 * CORS for the Chrome extension (chrome-extension:// origins). The API uses
 * no cookies, so a wildcard origin is safe; secrets never leave the server.
 * next.config.mjs applies these to every /api response; routes export
 * `OPTIONS` (below) so preflights succeed too.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-llm-provider, x-llm-key, x-llm-model",
  "Access-Control-Max-Age": "86400",
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
