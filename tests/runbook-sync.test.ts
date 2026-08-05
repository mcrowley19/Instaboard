import { describe, expect, it } from "vitest";
import { syncStatusOf } from "@/lib/runbook-sync";
import { documentDigest } from "@/lib/document-readback";

/**
 * The three-way decision is where "DataHub is the body of record" either holds
 * or quietly stops being true, so it gets tested to exhaustion as a pure
 * function. The live behavior on top of it — pull on catalog-ahead, refuse a
 * push whenever the catalog moved — is asserted by the reconcile receipts a
 * live run writes, same contract as every other live claim in this repo.
 */

const A = documentDigest("body as of the last sync");
const B = documentDigest("edited in DataHub");
const C = documentDigest("edited locally");

describe("syncStatusOf", () => {
  it("reports in-sync when neither side moved", () => {
    expect(syncStatusOf({ catalogDigest: A, localDigest: A, baseCatalog: A, baseLocal: A })).toBe("in-sync");
  });

  it("reports catalog-ahead when only the document in DataHub moved", () => {
    expect(syncStatusOf({ catalogDigest: B, localDigest: A, baseCatalog: A, baseLocal: A })).toBe("catalog-ahead");
  });

  it("reports local-ahead when only the runbook here moved", () => {
    expect(syncStatusOf({ catalogDigest: A, localDigest: C, baseCatalog: A, baseLocal: A })).toBe("local-ahead");
  });

  it("reports conflict when both sides moved, whatever they moved to", () => {
    expect(syncStatusOf({ catalogDigest: B, localDigest: C, baseCatalog: A, baseLocal: A })).toBe("conflict");
    expect(syncStatusOf({ catalogDigest: B, localDigest: B, baseCatalog: A, baseLocal: A })).toBe("conflict");
  });

  it("adopts the catalog as base for a handoff that predates sync digests", () => {
    // No recorded base: the catalog copy defines the base, so an old handoff's
    // first reconcile is never a conflict nobody caused.
    expect(syncStatusOf({ catalogDigest: B, localDigest: B })).toBe("in-sync");
    expect(syncStatusOf({ catalogDigest: B, localDigest: C })).toBe("in-sync");
  });

  it("still sees a local edit when only the catalog base is missing", () => {
    expect(syncStatusOf({ catalogDigest: A, localDigest: C, baseLocal: A })).toBe("local-ahead");
  });
});

describe("the digest the compare runs on", () => {
  it("is indifferent to line endings and trailing whitespace, nothing else", () => {
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
    expect(documentDigest(normalize("a\r\nb\n\n"))).toBe(documentDigest(normalize("a\nb")));
    expect(documentDigest(normalize("a\nb"))).not.toBe(documentDigest(normalize("a\nc")));
  });
});
