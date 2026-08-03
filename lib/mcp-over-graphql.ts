/**
 * The catalog tools instaboard needs, spoken over GraphQL instead of MCP.
 *
 * `mcp-server-datahub` is a subprocess spawned over stdio. Serverless runtimes
 * will not spawn one, which is why the hosted demo has always self-reported
 * `demo: true, fallback: true` — no `uvx`, so no catalog, so the fixture. The
 * effect is that the thing this project is actually for, writing state back into
 * DataHub and reading it out again, was the one thing a judge could not see
 * without cloning the repo.
 *
 * DataHub's GraphQL API is plain HTTP and needs no subprocess. The loop uses
 * four tools — `get_entities`, `get_dataset_health`, `save_document`, `add_tags`
 * — and every one has a GraphQL equivalent already serving the DataHub UI. So
 * this implements those four against it, in the response shape the MCP server
 * returns, and `lib/mcp.ts` reaches for it when the subprocess is unavailable
 * but a GMS is not.
 *
 * It is deliberately **not** a general MCP replacement. Anything outside these
 * four tools returns `isError` and says to use the real server; a shim that
 * quietly half-implemented the surface would be worse than no shim, because the
 * failures would look like catalog answers.
 */

import { datahubGraphQL } from "./datahub-graphql";

/* ── Entity reads ─────────────────────────────────────────────────────── */

/**
 * Mirrors the aspects `lib/decay.ts` reads off an entity: schema fields, owners,
 * deprecation, health. `decay.ts` deep-scans for the keys it needs rather than
 * assuming a layout, so what matters here is that the *keys* match what the MCP
 * server emits — `fieldPath`, `deprecation.note`, `health.status` — not that the
 * envelope does.
 */
const GET_ENTITIES = `
  query getEntities($urns: [String!]!) {
    entities(urns: $urns) {
      urn
      type
      ... on Dataset {
        name
        exists
        status { removed }
        properties { name description }
        schemaMetadata(version: 0) {
          fields { fieldPath nativeDataType description }
        }
        ownership { owners { owner { ... on CorpUser { urn properties { displayName email } } ... on CorpGroup { urn properties { displayName } } } } }
        deprecation { deprecated note }
        health { type status message causes }
        tags { tags { tag { urn properties { name } } } }
      }
    }
  }
`;

/**
 * `batchAddTags`, not `addTags`, because every caller in this repo tags several
 * datasets at once — a stale runbook usually breaks on more than one.
 */
const BATCH_ADD_TAGS = `
  mutation batchAddTags($input: BatchAddTagsInput!) { batchAddTags(input: $input) }
`;

const CREATE_DOCUMENT = `
  mutation createDocument($input: CreateDocumentInput!) { createDocument(input: $input) }
`;

/** The tools this shim can honestly answer. Everything else is refused. */
export const GRAPHQL_TOOLS = new Set(["get_entities", "get_dataset_health", "save_document", "add_tags"]);

type ToolResult = { content: string; isError: boolean };

const ok = (value: unknown): ToolResult => ({ content: JSON.stringify(value), isError: false });
const fail = (message: string): ToolResult => ({ content: message, isError: true });

function urnsFrom(args: Record<string, unknown>): string[] {
  const raw = args.urns ?? args.urn;
  if (Array.isArray(raw)) return raw.filter((u): u is string => typeof u === "string");
  return typeof raw === "string" ? [raw] : [];
}

/**
 * Run one of the four supported tools against GraphQL.
 *
 * Returns `null` — rather than an error — for a tool it does not implement, so
 * the caller can tell "this shim does not cover that" apart from "the catalog
 * said no". Those are different problems and only one of them is the catalog's.
 */
export async function callToolOverGraphQL(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult | null> {
  if (!GRAPHQL_TOOLS.has(name)) return null;

  switch (name) {
    case "get_entities":
    case "get_dataset_health": {
      const urns = urnsFrom(args);
      if (urns.length === 0) return fail("get_entities: no urns given");

      const result = await datahubGraphQL<{ entities: ({ exists?: boolean } | null)[] }>(GET_ENTITIES, {
        urns,
      });
      if (result.errors?.length) return fail(`get_entities: ${result.errors[0].message}`);

      // GraphQL answers a URN that was never ingested with a *stub* — the right
      // `type`, every aspect null — rather than with nothing. Passing that up
      // would report a deleted dataset as present-but-unreadable and swallow the
      // `entity-missing` finding, which is one of the findings that matters
      // most. `exists` is what tells the two apart.
      const entities = (result.data?.entities ?? []).filter(
        (e): e is { exists?: boolean } => Boolean(e) && e!.exists !== false
      );
      if (entities.length === 0) return ok({ entities: [], error: "not found in catalog" });
      return ok(entities.length === 1 ? entities[0] : entities);
    }

    case "add_tags": {
      const tagUrns = (Array.isArray(args.tag_urns) ? args.tag_urns : [args.tag_urn]).filter(
        (t): t is string => typeof t === "string"
      );
      // Callers in this repo pass `entity_urns`; `resource_urn` is accepted too
      // because the MCP tool's own schema has used both spellings.
      const entityUrns = (
        Array.isArray(args.entity_urns) ? args.entity_urns : [args.entity_urns ?? args.resource_urn]
      ).filter((u): u is string => typeof u === "string");

      if (entityUrns.length === 0 || tagUrns.length === 0) {
        return fail("add_tags: need entity_urns (or resource_urn) and tag_urns");
      }
      const result = await datahubGraphQL<{ batchAddTags: boolean }>(BATCH_ADD_TAGS, {
        input: { tagUrns, resources: entityUrns.map((resourceUrn) => ({ resourceUrn })) },
      });
      if (result.errors?.length) return fail(`add_tags: ${result.errors[0].message}`);
      return ok({ success: result.data?.batchAddTags === true, entityUrns, tagUrns });
    }

    case "save_document": {
      const title = typeof args.title === "string" ? args.title : "Untitled";
      const content = typeof args.content === "string" ? args.content : "";
      const related = (Array.isArray(args.related_assets) ? args.related_assets : []).filter(
        (u): u is string => typeof u === "string"
      );
      const result = await datahubGraphQL<{ createDocument: string }>(CREATE_DOCUMENT, {
        input: {
          title,
          subType: typeof args.document_type === "string" ? args.document_type : "Note",
          contents: { text: content },
          // `[String!]`, not objects. Sending `{ asset: urn }` makes GMS try to
          // resolve the whole object as a URN and fail the write.
          ...(related.length ? { relatedAssets: related } : {}),
        },
      });
      if (result.errors?.length) return fail(`save_document: ${result.errors[0].message}`);
      const urn = result.data?.createDocument;
      if (!urn) return fail("save_document: DataHub returned no document URN");
      return ok({ success: true, urn, message: `Successfully created document: ${title}` });
    }
  }

  return null;
}
