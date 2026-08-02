/**
 * Raw aspect reads and writes against GMS's OpenAPI v3 surface.
 *
 * Used only by the drills that deliberately change a catalog — dropping a column,
 * putting it back — because a schema edit is not something the GraphQL API or the
 * MCP server exposes. Nothing in the product path writes aspects this way.
 */

const GMS = () => process.env.DATAHUB_GMS_URL || "http://localhost:8080";

function authHeaders(): Record<string, string> {
  return process.env.DATAHUB_GMS_TOKEN ? { Authorization: `Bearer ${process.env.DATAHUB_GMS_TOKEN}` } : {};
}

export async function readAspect(urn: string, aspect: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${GMS()}/openapi/v3/entity/dataset/${encodeURIComponent(urn)}/${aspect}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { value?: Record<string, unknown> };
  return body.value ?? null;
}

export async function writeAspect(urn: string, aspect: string, value: Record<string, unknown>): Promise<void> {
  const res = await fetch(
    `${GMS()}/openapi/v3/entity/dataset/${encodeURIComponent(urn)}/${aspect}?createIfNotExists=false`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!res.ok) throw new Error(`writeAspect ${aspect} on ${urn}: ${res.status} ${await res.text()}`);
}
