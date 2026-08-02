/**
 * A small direct client for DataHub's GraphQL API.
 *
 * Anything instaboard can do over MCP, it does over MCP. This file covers the one
 * thing the MCP server has no tool for, which is incidents. Version 0.6.0 exposes
 * 20 tools covering search, entity and lineage and schema reads, document search,
 * and a set of metadata mutations for tags, terms, owners, domains, descriptions,
 * structured properties and `save_document`. None of them raises or resolves an
 * incident, although `raiseIncident` has been in the GraphQL API for years and
 * incidents are one of the two health signals DataHub surfaces on an entity.
 *
 * A decay finding written into a Document is a real contribution, and it waits
 * there until somebody opens the document. An incident shows on the entity's
 * health badge, filters in search and fires subscriptions people already have. So
 * findings that break a runbook drop down to GraphQL and raise the native thing.
 *
 * The gap is written up in `submission/oss/issues/`.
 */

const GMS_URL = () => process.env.DATAHUB_GMS_URL || "http://localhost:8080";

export interface GraphQLResult<T> {
  data?: T;
  errors?: { message: string }[];
}

export async function datahubGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<GraphQLResult<T>> {
  const token = process.env.DATAHUB_GMS_TOKEN;
  try {
    const res = await fetch(`${GMS_URL()}/api/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return { errors: [{ message: `GMS returned ${res.status} ${res.statusText}` }] };
    }
    return (await res.json()) as GraphQLResult<T>;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** True when GMS answers. Demo mode uses this to skip the native write-back. */
export async function gmsReachable(): Promise<boolean> {
  const r = await datahubGraphQL<{ __typename: string }>("{ __typename }");
  return Boolean(r.data && !r.errors);
}
