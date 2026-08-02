import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pageContextBlock } from "@/lib/prompts";

/**
 * The side panel's entity detection runs in the browser and so never gets
 * exercised by the server tests. These load the shipped detection module and run
 * it over URLs copied from a running DataHub, so the check cannot drift from
 * what the extension actually does.
 *
 * The exhaustive route coverage lives in `entity-from-url.test.ts`; this file
 * checks the slice the side panel depends on, end to end into the prompt.
 */

function loadDetector(): (href: string) => { urn: string; entityType: string } | null {
  const source = readFileSync(path.join(process.cwd(), "extension", "entity-from-url.js"), "utf8");
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", source)(module);
  return (module.exports as { datahubEntityFromUrl: (href: string) => { urn: string; entityType: string } | null })
    .datahubEntityFromUrl;
}

const datahubEntityFromUrl = loadDetector();

/** What content.js hands the side panel for a given page URL. */
function extract(url: string): { entityType?: string; datasetUrn?: string } {
  const entity = datahubEntityFromUrl(url);
  return entity ? { entityType: entity.entityType, datasetUrn: entity.urn } : {};
}

describe("extension content script", () => {
  it("pulls the entity out of a DataHub dataset URL", () => {
    // Copied from a browser address bar on a running quickstart, showing an
    // entity from DataHub's own showcase-ecommerce datapack.
    const url =
      "http://localhost:9002/dataset/urn%3Ali%3Adataset%3A(urn%3Ali%3AdataPlatform%3Asnowflake%2Cb2fd91.order_entry_db.analytics.order_details%2CPROD)/Incidents";

    expect(extract(url)).toEqual({
      entityType: "dataset",
      datasetUrn:
        "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)",
    });
  });

  it("handles the seeded Northbeam catalog and a tab suffix", () => {
    const url =
      "http://localhost:9002/dataset/urn%3Ali%3Adataset%3A(urn%3Ali%3AdataPlatform%3Asnowflake%2Canalytics.marts.fct_revenue%2CPROD)/Schema";

    expect(extract(url).datasetUrn).toBe(
      "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)"
    );
  });

  it("reads non-dataset entities too", () => {
    expect(extract("http://localhost:9002/glossaryTerm/urn:li:glossaryTerm:MRR/Documentation")).toEqual({
      entityType: "glossaryTerm",
      datasetUrn: "urn:li:glossaryTerm:MRR",
    });
    expect(extract("http://localhost:9002/domain/urn:li:domain:Payments/Assets").entityType).toBe("domain");
  });

  it("detects the entity types whose route does not match their name", () => {
    // These were silently undetected until the routes were read off a running
    // DataHub: a pipeline lives at /pipelines/, a task at /tasks/.
    expect(extract("http://localhost:9002/pipelines/urn:li:dataFlow:(spark,nightly,PROD)").entityType).toBe("dataFlow");
    expect(
      extract("http://localhost:9002/tasks/urn:li:dataJob:(urn:li:dataFlow:(spark,nightly,PROD),load)").entityType
    ).toBe("dataJob");
    // Our own runbooks are documents, and those pages went undetected too.
    expect(extract("http://localhost:9002/document/urn:li:document:runbook-1").entityType).toBe("document");
  });

  it("stays quiet on DataHub pages that are not an entity", () => {
    expect(extract("http://localhost:9002/search?query=revenue")).toEqual({});
    expect(extract("http://localhost:9002/")).toEqual({});
  });

  it("survives a malformed URL instead of throwing", () => {
    expect(() => extract("http://localhost:9002/dataset/%E0%A4%A")).not.toThrow();
  });

  it("hands the detected entity to the agent as page context", () => {
    const url =
      "http://localhost:9002/dataset/urn%3Ali%3Adataset%3A(urn%3Ali%3AdataPlatform%3Asnowflake%2Cb2fd91.order_entry_db.analytics.order_details%2CPROD)/Schema";
    const detected = extract(url);

    // This is the object the side panel POSTs to /api/chat.
    const block = pageContextBlock({
      url,
      title: "order_details | Model",
      datasetUrn: detected.datasetUrn,
      entityType: detected.entityType,
      selection: "cost_of_delivery",
    });

    expect(block).toContain("b2fd91.order_entry_db.analytics.order_details");
    expect(block).toContain("cost_of_delivery");
  });
});
