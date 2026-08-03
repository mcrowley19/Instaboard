/**
 * Reading instaboard's own documents back out of DataHub.
 *
 * Every write in this repo is checked by reading it back — a tag, an incident, an
 * assertion, a structured property. Documents were the exception, and the
 * exception was load-bearing: `save_document` returns a URN, and no MCP tool will
 * give you that document's content again. `get_entities` on a document URN
 * returns `{"urn": "..."}` and nothing else. So the runbook body lived in local
 * storage and DataHub held a copy nobody could verify, which is the one hole in
 * "institutional memory lives in the graph".
 *
 * It turns out DataHub was never the problem. Its GraphQL API returns
 * `Document.info.contents.text` in full, on the same OSS server, in the same
 * query. The MCP server strips the `... on Document` selection because the whole
 * block is tagged `#[NEWER_GMS]` and those fields are enabled only for DataHub
 * Cloud — so a self-hosted GMS is denied fields it serves perfectly well. That is
 * a fix we wrote, tested and sent upstream:
 * `submission/oss/prs/mcp-server-datahub-newer-gms-on-oss.patch`.
 *
 * Until that lands in a release, this module goes round it the same way
 * `lib/datahub-graphql.ts` goes round the missing incident tools: straight to
 * GraphQL, which has the data. So the round trip closes now, on a stock OSS
 * DataHub, rather than after an upstream release cycle.
 */

import { createHash } from "node:crypto";
import { datahubGraphQL } from "./datahub-graphql";
import { isDemoMode } from "./mcp";
import type { RoundTripReceipt } from "./types";

const READ_DOCUMENT = `
  query readDocument($urn: String!) {
    entity(urn: $urn) {
      urn
      ... on Document {
        info {
          title
          contents { text }
          relatedAssets { asset { urn } }
        }
      }
    }
  }
`;

export interface StoredDocument {
  urn: string;
  title?: string;
  content: string;
  relatedAssets: string[];
}

interface ReadDocumentResponse {
  entity: {
    urn: string;
    info?: {
      title?: string;
      contents?: { text?: string } | null;
      relatedAssets?: { asset?: { urn?: string } }[] | null;
    } | null;
  } | null;
}

/**
 * Read a document back by URN. `null` means the read genuinely failed — the URN
 * is unknown, or GMS is not answering — rather than "the document is empty",
 * which is a distinction the caller needs in order to fail honestly.
 */
export async function readDocument(urn: string): Promise<StoredDocument | null> {
  const result = await datahubGraphQL<ReadDocumentResponse>(READ_DOCUMENT, { urn });
  const entity = result.data?.entity;
  if (result.errors?.length || !entity) return null;

  const info = entity.info;
  // An entity that came back without an `info` block is a document this server
  // will not serve the body of. Reporting that as empty content would turn a
  // capability gap into a false claim about the document.
  if (!info) return null;

  return {
    urn: entity.urn,
    ...(info.title ? { title: info.title } : {}),
    content: info.contents?.text ?? "",
    relatedAssets: (info.relatedAssets ?? []).map((r) => r.asset?.urn).filter((u): u is string => Boolean(u)),
  };
}

/**
 * Pull the document URN out of whatever `save_document` answered with. The
 * response shape has moved between MCP server versions, so this looks for a
 * document URN anywhere in it rather than at a fixed path.
 */
export function documentUrnFrom(result: { content: string; isError: boolean }): string | undefined {
  if (result.isError) return undefined;
  return result.content.match(/urn:li:document:[A-Za-z0-9._\-]+/)?.[0];
}

/** Content-addressed, so two copies can be compared without shipping either. */
export const documentDigest = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);

export type { RoundTripReceipt };

/**
 * Write, then read, then compare. The receipt is the point: a write nobody read
 * back is a claim, and this repo's whole argument is that claims should come with
 * the read that settles them.
 *
 * Content is compared after normalising line endings and trailing whitespace,
 * because DataHub is entitled to normalise what it stores and a diff in `\r\n`
 * is not a diff in the runbook.
 */
export async function verifyDocumentRoundTrip(urn: string, written: string): Promise<RoundTripReceipt> {
  const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
  const writtenNorm = normalize(written);
  const base = {
    urn,
    writtenChars: writtenNorm.length,
    writtenDigest: documentDigest(writtenNorm),
    at: new Date().toISOString(),
  };

  if (isDemoMode()) {
    return { ...base, readBack: false, readChars: 0, matches: false, error: "demo mode: no DataHub to read from" };
  }

  const stored = await readDocument(urn);
  if (!stored) {
    return {
      ...base,
      readBack: false,
      readChars: 0,
      matches: false,
      error:
        "DataHub did not return the document body. On a server predating Documents this is expected; " +
        "on 1.5+ it means the read path is not serving `Document.info.contents`.",
    };
  }

  const readNorm = normalize(stored.content);
  return {
    ...base,
    readBack: true,
    readChars: readNorm.length,
    readDigest: documentDigest(readNorm),
    matches: readNorm === writtenNorm,
  };
}
