import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pageContextBlock } from "@/lib/prompts";

/**
 * The side panel's entity detection lives in the extension's content script,
 * which runs in the browser and so never gets exercised by the server tests.
 * These tests read the regex straight out of `extension/content.js` and run it
 * over URLs copied from a running DataHub, so the check cannot drift from the
 * shipped extension.
 */

const contentScript = readFileSync(
  path.join(process.cwd(), "extension", "content.js"),
  "utf8"
);

/** Pull `URN_ROUTE_RE` out of the content script rather than restating it here. */
function urnRoute(): RegExp {
  const match = contentScript.match(/const URN_ROUTE_RE\s*=\s*([\s\S]*?);\n/);
  if (!match) throw new Error("URN_ROUTE_RE not found in extension/content.js");
  // eslint-disable-next-line no-eval
  return eval(match[1]) as RegExp;
}

/**
 * What content.js does to a page URL before it reaches the side panel,
 * including its guard around `decodeURIComponent`, which throws on a truncated
 * percent-escape.
 */
function extract(url: string): { entityType?: string; datasetUrn?: string } {
  try {
    const m = decodeURIComponent(url).match(urnRoute());
    return m ? { entityType: m[1], datasetUrn: m[2] } : {};
  } catch {
    return {};
  }
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
