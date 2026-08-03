import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentDigest, readDocument, verifyDocumentRoundTrip } from "../lib/document-readback";

/**
 * The read leg of the document round trip.
 *
 * Documents were the one thing this repo wrote into DataHub and could not read
 * back, because no MCP tool returns a document's body. GraphQL does, so this
 * reads it there. What matters in these tests is the failure direction: a body
 * DataHub will not serve must come back as "could not read", never as "read it,
 * and it was empty" — the second is a false claim about the catalog's contents,
 * and it would make an unverifiable write look verified.
 */

let response: { data?: unknown; errors?: { message: string }[] } = {};

vi.mock("../lib/mcp", () => ({ isDemoMode: () => false }));
vi.mock("../lib/datahub-graphql", () => ({
  datahubGraphQL: async () => response,
}));

const URN = "urn:li:document:shared-abc";

const withDocument = (text: string, title = "Stale runbook: Weekly order revenue pack") => ({
  data: {
    entity: {
      urn: URN,
      info: {
        title,
        contents: { text },
        relatedAssets: [{ asset: { urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,a.b.c,PROD)" } }],
      },
    },
  },
});

beforeEach(() => {
  response = {};
});

describe("readDocument", () => {
  it("returns the stored body, title and related assets", async () => {
    response = withDocument("# Runbook validation\n\nStill accurate.");
    expect(await readDocument(URN)).toEqual({
      urn: URN,
      title: "Stale runbook: Weekly order revenue pack",
      content: "# Runbook validation\n\nStill accurate.",
      relatedAssets: ["urn:li:dataset:(urn:li:dataPlatform:snowflake,a.b.c,PROD)"],
    });
  });

  it("reports a server that returns the URN alone as a failed read, not an empty document", async () => {
    // Exactly what `get_entities` returns for a document today: the URN it was
    // given, and nothing else. Calling that an empty document would be a lie
    // about a document that has 5kB of content in it.
    response = { data: { entity: { urn: URN } } };
    expect(await readDocument(URN)).toBeNull();
  });

  it("reports a GraphQL error as a failed read", async () => {
    response = { errors: [{ message: "FieldUndefined" }] };
    expect(await readDocument(URN)).toBeNull();
  });

  it("distinguishes a genuinely empty body from an unserved one", async () => {
    response = withDocument("");
    expect(await readDocument(URN)).toMatchObject({ content: "" });
  });
});

describe("verifyDocumentRoundTrip", () => {
  it("confirms a document that came back byte for byte", async () => {
    const content = "# Runbook validation\n\nStill accurate.";
    response = withDocument(content);
    const receipt = await verifyDocumentRoundTrip(URN, content);
    expect(receipt).toMatchObject({ readBack: true, matches: true, writtenChars: content.length });
    expect(receipt.readDigest).toBe(receipt.writtenDigest);
  });

  it("catches a document that came back different", async () => {
    response = withDocument("# Runbook validation\n\nSomething else entirely.");
    const receipt = await verifyDocumentRoundTrip(URN, "# Runbook validation\n\nStill accurate.");
    expect(receipt).toMatchObject({ readBack: true, matches: false });
    expect(receipt.readDigest).not.toBe(receipt.writtenDigest);
  });

  it("ignores line-ending and trailing-whitespace normalisation by the server", async () => {
    // DataHub is entitled to normalise what it stores. A difference in `\r\n` is
    // not a difference in the runbook, and failing the receipt on one would
    // train everybody to ignore the receipt.
    response = withDocument("line one\nline two");
    expect(await verifyDocumentRoundTrip(URN, "line one\r\nline two\n")).toMatchObject({ matches: true });
  });

  it("fails the receipt, rather than the write, when the body cannot be read", async () => {
    response = { data: { entity: { urn: URN } } };
    const receipt = await verifyDocumentRoundTrip(URN, "whatever was sent");
    expect(receipt.readBack).toBe(false);
    expect(receipt.matches).toBe(false);
    expect(receipt.error).toMatch(/did not return the document body/);
    // The digest of what we sent is still recorded, so the write is auditable
    // even when the read leg is unavailable.
    expect(receipt.writtenDigest).toBe(documentDigest("whatever was sent"));
  });
});
