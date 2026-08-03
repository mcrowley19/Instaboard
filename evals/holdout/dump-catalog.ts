/**
 * Dump the catalog the held-out benchmark is written against.
 *
 *   npx tsx evals/holdout/dump-catalog.ts
 *
 * This is the *only* thing the independent question author is shown. It is a
 * flat rendering of what DataHub holds for `showcase-ecommerce` — the datapack
 * DataHub publishes, which nobody here authored — read straight off a live GMS
 * over GraphQL: datasets, columns, owners, descriptions, deprecations, glossary
 * terms, domains and tags.
 *
 * It is committed so that anyone can check what the author had to work with.
 * The point of the exercise is that the author saw the catalog and nothing else
 * — not instaboard's system prompt, not its tool list, not its scorer, not the
 * benchmark cases we wrote ourselves. If this file grew a hint about any of
 * those, the independence claim would be worth nothing, so it is generated
 * mechanically and never edited by hand.
 *
 * Writes evals/holdout/catalog-dump.json and its sha256 into the same file.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { datahubGraphQL, gmsReachable } from "../../lib/datahub-graphql";

/** Every showcase entity carries this prefix; the datapack namespaces itself. */
const SHOWCASE_MARKER = "b2fd91";

interface DumpedField {
  name: string;
  type: string;
  description?: string;
}

interface DumpedDataset {
  urn: string;
  name: string;
  platform: string;
  description?: string;
  deprecated?: { note: string };
  owners: { urn: string; name: string; type: string }[];
  fields: DumpedField[];
  glossaryTerms: string[];
  tags: string[];
  domain?: string;
  upstreams: string[];
}

const SEARCH = `
  query($start: Int!, $count: Int!) {
    searchAcrossEntities(input: { types: [DATASET], query: "*", start: $start, count: $count }) {
      total
      searchResults { entity { urn } }
    }
  }
`;

const DETAIL = `
  query($urn: String!) {
    dataset(urn: $urn) {
      urn
      name
      platform { name }
      properties { description }
      deprecation { deprecated note }
      ownership { owners { owner { ... on CorpUser { urn properties { displayName fullName } } ... on CorpGroup { urn properties { displayName } } } ownershipType { urn } } }
      schemaMetadata { fields { fieldPath type nativeDataType description } }
      glossaryTerms { terms { term { urn properties { name } } } }
      tags { tags { tag { urn properties { name } } } }
      domain { domain { urn properties { name } } }
      upstream: lineage(input: { direction: UPSTREAM, start: 0, count: 25 }) {
        relationships { entity { urn } }
      }
    }
  }
`;

interface DetailResponse {
  dataset: {
    urn: string;
    name: string;
    platform?: { name?: string };
    properties?: { description?: string };
    deprecation?: { deprecated?: boolean; note?: string };
    ownership?: {
      owners?: {
        owner?: { urn?: string; properties?: { displayName?: string; fullName?: string } };
        ownershipType?: { urn?: string };
      }[];
    };
    schemaMetadata?: { fields?: { fieldPath: string; type?: string; nativeDataType?: string; description?: string }[] };
    glossaryTerms?: { terms?: { term?: { properties?: { name?: string } } }[] };
    tags?: { tags?: { tag?: { properties?: { name?: string } } }[] };
    domain?: { domain?: { properties?: { name?: string } } };
    upstream?: { relationships?: { entity?: { urn?: string } }[] };
  } | null;
}

async function collectUrns(): Promise<string[]> {
  const urns: string[] = [];
  for (let start = 0; start < 2000; start += 100) {
    const page = await datahubGraphQL<{
      searchAcrossEntities: { total: number; searchResults: { entity: { urn: string } }[] };
    }>(SEARCH, { start, count: 100 });
    const results = page.data?.searchAcrossEntities?.searchResults ?? [];
    if (results.length === 0) break;
    urns.push(...results.map((r) => r.entity.urn));
    if (urns.length >= (page.data?.searchAcrossEntities?.total ?? 0)) break;
  }
  return urns.filter((urn) => urn.includes(SHOWCASE_MARKER));
}

async function detail(urn: string): Promise<DumpedDataset | null> {
  const res = await datahubGraphQL<DetailResponse>(DETAIL, { urn });
  const d = res.data?.dataset;
  if (!d) return null;

  return {
    urn: d.urn,
    name: d.name,
    platform: d.platform?.name ?? "unknown",
    ...(d.properties?.description ? { description: d.properties.description } : {}),
    ...(d.deprecation?.deprecated ? { deprecated: { note: d.deprecation.note ?? "" } } : {}),
    owners: (d.ownership?.owners ?? [])
      .filter((o) => o.owner?.urn)
      .map((o) => ({
        urn: o.owner!.urn!,
        name: o.owner!.properties?.displayName || o.owner!.properties?.fullName || o.owner!.urn!,
        type: (o.ownershipType?.urn ?? "").replace("urn:li:ownershipType:", ""),
      })),
    fields: (d.schemaMetadata?.fields ?? []).map((f) => ({
      name: f.fieldPath,
      type: f.nativeDataType || f.type || "unknown",
      ...(f.description ? { description: f.description } : {}),
    })),
    glossaryTerms: (d.glossaryTerms?.terms ?? []).map((t) => t.term?.properties?.name ?? "").filter(Boolean),
    tags: (d.tags?.tags ?? []).map((t) => t.tag?.properties?.name ?? "").filter(Boolean),
    ...(d.domain?.domain?.properties?.name ? { domain: d.domain.domain.properties.name } : {}),
    upstreams: (d.upstream?.relationships ?? []).map((r) => r.entity?.urn ?? "").filter(Boolean),
  };
}

async function main(): Promise<void> {
  if (!(await gmsReachable())) {
    console.error("DataHub is not answering. Start it with `npm run datahub:up` and load the datapack:");
    console.error("  DATAHUB_GMS_URL=http://localhost:8080 datahub datapack load showcase-ecommerce");
    process.exit(1);
  }

  const urns = await collectUrns();
  console.log(`${urns.length} showcase datasets found; reading each one…`);

  const datasets: DumpedDataset[] = [];
  for (const urn of urns) {
    const d = await detail(urn);
    if (d) datasets.push(d);
  }
  datasets.sort((a, b) => a.urn.localeCompare(b.urn));

  const body = {
    catalog: "showcase-ecommerce",
    source: "DataHub's published demo datapack, read over GraphQL from a live GMS",
    datasetCount: datasets.length,
    datasets,
  };
  const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");

  const out = path.join(process.cwd(), "evals", "holdout", "catalog-dump.json");
  writeFileSync(out, JSON.stringify({ ...body, sha256 }, null, 2));

  const columns = datasets.reduce((n, d) => n + d.fields.length, 0);
  const owned = datasets.filter((d) => d.owners.length > 0).length;
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
  console.log(`  ${datasets.length} datasets, ${columns} columns, ${owned} with owners`);
  console.log(`  sha256 ${sha256}`);
}

void main();
