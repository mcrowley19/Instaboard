/**
 * Which DataHub entity is this page showing?
 *
 * DataHub's UI puts the URN in the URL, so a browser integration can read it
 * without an API call. What it does not do is make the mapping from entity type
 * to URL segment discoverable, and the mapping is not derivable: a `dataJob`
 * lives at `/tasks/`, a `dataFlow` at `/pipelines/`, an `mlFeature` at
 * `/features/`. Eleven of the thirty-one routes do not match their entity type
 * name, and five of those are a different word entirely.
 *
 * We got this wrong from the first version of the extension until this commit.
 * It pattern-matched
 * `/dataFlow/` and `/dataJob/`, which are not routes DataHub has ever served, so
 * the side panel silently failed to detect a page whenever somebody opened a
 * pipeline or a task — the two entity types an onboarding tool most wants to see.
 * It failed by returning "no entity", which looks exactly like "not a DataHub
 * page", so nothing ever surfaced the bug.
 *
 * The table below was read off a running DataHub rather than guessed: extracted
 * from the frontend bundle's entity registry (`getPathName()` per entity) and
 * spot-checked against real hrefs in the UI. See
 * `submission/oss/entity-detection/` for the write-up and the test vectors, and
 * the upstream issue asking DataHub to publish this contract so integrators stop
 * reverse-engineering it.
 *
 * Dependency-free and side-effect-free on purpose: it is loaded as a content
 * script, imported by the tests, and vendored into the upstream contribution
 * from this one file.
 */

/**
 * URL path segment → DataHub entity type.
 *
 * Extracted from DataHub 1.5.0.6's frontend bundle. Segments marked "≠ type" are
 * the ones you cannot guess from the entity type, which is the whole reason this
 * table has to exist.
 */
const DATAHUB_ROUTES = {
  dataset: "dataset",
  dashboard: "dashboard",
  chart: "chart",
  pipelines: "dataFlow", // ≠ type
  tasks: "dataJob", // ≠ type
  glossaryTerm: "glossaryTerm",
  glossaryNode: "glossaryNode",
  domain: "domain",
  container: "container",
  tag: "tag",
  user: "corpUser", // ≠ type
  group: "corpGroup", // ≠ type
  mlModels: "mlModel", // ≠ type
  mlModelGroup: "mlModelGroup",
  featureTables: "mlFeatureTable", // ≠ type
  features: "mlFeature", // ≠ type
  mlPrimaryKeys: "mlPrimaryKey", // ≠ type
  dataProduct: "dataProduct",
  dataProcessInstance: "dataProcessInstance",
  dataPlatformInstance: "dataPlatformInstance",
  platform: "dataPlatform", // ≠ type
  erModelRelationship: "erModelRelationship",
  schemaField: "schemaField",
  query: "query",
  notebook: "notebook",
  application: "application",
  "business-attribute": "businessAttribute", // ≠ type
  dataContracts: "dataContract", // ≠ type
  document: "document",
  role: "role",
  restricted: "restricted",
};

/**
 * A URN can contain slashes, parentheses and percent-encoding — an S3 dataset
 * URN carries `demo-data-bucket/order_entry/orders` inside it. So stop at the
 * first `?` or `#`, and at a `/` only when what follows is a DataHub tab name
 * rather than more URN. Everything DataHub appends after the URN is either a tab
 * (`/Columns`, `/Lineage`, `/Schema`) or nothing, and a URN's own slashes always
 * sit inside the parenthesised part.
 */
const ROUTE_RE = new RegExp(
  "/(" + Object.keys(DATAHUB_ROUTES).join("|") + ")/(urn:li:[^?#]+?)(?:/[A-Z][A-Za-z ]*)?/?(?:[?#]|$)"
);

/**
 * Read the entity a DataHub URL is showing.
 *
 * @param {string} href a full URL or a path
 * @returns {{urn: string, entityType: string, route: string} | null}
 */
function datahubEntityFromUrl(href) {
  if (typeof href !== "string" || !href) return null;

  // DataHub percent-encodes the URN in the address bar; the raw form appears in
  // hrefs. Try decoded first, then raw, so both spellings resolve.
  const candidates = [];
  try {
    candidates.push(decodeURIComponent(href));
  } catch {
    // Truncated percent-escape — the raw string may still match.
  }
  candidates.push(href);

  for (const candidate of candidates) {
    const match = candidate.match(ROUTE_RE);
    if (!match) continue;
    const route = match[1];
    // Trailing slash is part of DataHub's own hrefs, never part of the URN.
    const urn = match[2].replace(/\/+$/, "");
    if (!urn.startsWith("urn:li:")) continue;
    return { urn, entityType: DATAHUB_ROUTES[route], route };
  }
  return null;
}

// Usable as a content script (globals), from a bundler, and from Node's require.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { datahubEntityFromUrl, DATAHUB_ROUTES };
}
