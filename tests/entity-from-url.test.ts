import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Entity detection runs in the browser, so the server test suite would never
 * exercise it. These tests load the shipped content-script module itself and run
 * it over URLs captured from a running DataHub, so the check cannot drift from
 * what the extension actually does — and neither can the copy published
 * upstream, which is generated from the same file.
 */

function loadModule(): {
  datahubEntityFromUrl: (href: string) => { urn: string; entityType: string; route: string } | null;
  DATAHUB_ROUTES: Record<string, string>;
} {
  const source = readFileSync(path.join(process.cwd(), "extension", "entity-from-url.js"), "utf8");
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", source)(module);
  return module.exports as ReturnType<typeof loadModule>;
}

const { datahubEntityFromUrl, DATAHUB_ROUTES } = loadModule();

interface Vector {
  url: string;
  entityType: string | null;
  urn: string | null;
  why?: string;
}

const vectors = (
  JSON.parse(
    readFileSync(path.join(process.cwd(), "submission", "oss", "entity-detection", "url-vectors.json"), "utf8")
  ) as { vectors: Vector[] }
).vectors;

describe("datahubEntityFromUrl, against URLs captured from a running DataHub", () => {
  for (const vector of vectors) {
    it(`${vector.entityType ?? "no entity"}: ${vector.why ?? vector.url.slice(0, 60)}`, () => {
      const result = datahubEntityFromUrl(vector.url);
      if (vector.urn === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result?.urn).toBe(vector.urn);
      expect(result?.entityType).toBe(vector.entityType);
    });
  }
});

describe("the routes that do not match their entity type", () => {
  // These are the whole reason the mapping cannot be derived, and the ones the
  // first version of this code got wrong.
  it.each([
    ["/pipelines/urn:li:dataFlow:(spark,flow,PROD)", "dataFlow"],
    ["/tasks/urn:li:dataJob:(urn:li:dataFlow:(spark,flow,PROD),job)", "dataJob"],
    ["/features/urn:li:mlFeature:(table,feature)", "mlFeature"],
    ["/featureTables/urn:li:mlFeatureTable:(urn:li:dataPlatform:sagemaker,table)", "mlFeatureTable"],
    ["/mlPrimaryKeys/urn:li:mlPrimaryKey:(table,key)", "mlPrimaryKey"],
    ["/mlModels/urn:li:mlModel:(urn:li:dataPlatform:sagemaker,model,PROD)", "mlModel"],
    ["/platform/urn:li:dataPlatform:snowflake", "dataPlatform"],
    ["/business-attribute/urn:li:businessAttribute:abc", "businessAttribute"],
    ["/user/urn:li:corpuser:priya.patel", "corpUser"],
    ["/group/urn:li:corpGroup:data-eng", "corpGroup"],
  ])("%s resolves to %s", (url, entityType) => {
    expect(datahubEntityFromUrl(url)?.entityType).toBe(entityType);
  });

  it("never matches a route DataHub does not serve", () => {
    // `/dataFlow/` and `/dataJob/` read like the obvious routes and are not real.
    // Matching them would be harmless; the bug was matching them *instead of*
    // the real ones, so assert the real ones exist and these are absent.
    expect(DATAHUB_ROUTES).not.toHaveProperty("dataFlow");
    expect(DATAHUB_ROUTES).not.toHaveProperty("dataJob");
    expect(DATAHUB_ROUTES.pipelines).toBe("dataFlow");
    expect(DATAHUB_ROUTES.tasks).toBe("dataJob");
  });
});

describe("URN extraction", () => {
  it("keeps slashes that belong to the URN", () => {
    const url = "/dataset/urn:li:dataset:(urn:li:dataPlatform:s3,bucket/path/to/table,PROD)";
    expect(datahubEntityFromUrl(url)?.urn).toBe("urn:li:dataset:(urn:li:dataPlatform:s3,bucket/path/to/table,PROD)");
  });

  it("drops the tab segment DataHub appends", () => {
    for (const tab of ["Schema", "Lineage", "Columns", "Properties", "Queries"]) {
      const url = `/dataset/urn:li:dataset:(urn:li:dataPlatform:snowflake,db.s.t,PROD)/${tab}`;
      expect(datahubEntityFromUrl(url)?.urn).toBe("urn:li:dataset:(urn:li:dataPlatform:snowflake,db.s.t,PROD)");
    }
  });

  it("drops query strings and fragments", () => {
    const base = "urn:li:dataset:(urn:li:dataPlatform:snowflake,db.s.t,PROD)";
    expect(datahubEntityFromUrl(`/dataset/${base}?is_lineage_mode=false`)?.urn).toBe(base);
    expect(datahubEntityFromUrl(`/dataset/${base}#section`)?.urn).toBe(base);
  });

  it("handles a full URL as well as a bare path", () => {
    const base = "urn:li:dataset:(urn:li:dataPlatform:snowflake,db.s.t,PROD)";
    expect(datahubEntityFromUrl(`https://acme.acryl.io/dataset/${base}`)?.urn).toBe(base);
  });

  it("returns null rather than throwing on rubbish input", () => {
    for (const input of ["", "not a url", "/", "https://example.com/dataset/", "/dataset/urn:li:"]) {
      expect(() => datahubEntityFromUrl(input)).not.toThrow();
    }
    expect(datahubEntityFromUrl("")).toBeNull();
    expect(datahubEntityFromUrl("https://news.ycombinator.com/")).toBeNull();
  });
});

describe("the copy published upstream", () => {
  it("is byte-identical to the module the extension ships", () => {
    const shipped = readFileSync(path.join(process.cwd(), "extension", "entity-from-url.js"), "utf8");
    const published = readFileSync(
      path.join(process.cwd(), "submission", "oss", "entity-detection", "datahub-entity-from-url.js"),
      "utf8"
    );
    // Publishing a copy that has drifted from what we run is worse than not
    // publishing one, so this fails the build rather than trusting a habit.
    expect(published).toBe(shipped);
  });
});
