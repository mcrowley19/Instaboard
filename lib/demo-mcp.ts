import {
  DEMO_DATASETS,
  DEMO_DOMAINS,
  DEMO_LINEAGE,
  DEMO_QUERIES,
  DEMO_TAGS,
  DEMO_TERMS,
  DEMO_USERS,
  type DemoDataset,
} from "./demo-catalog";
import type { ToolDef } from "./types";

/**
 * Demo-mode stand-in for the DataHub MCP server: the same tool surface
 * (search / get_entities / get_lineage / get_dataset_queries / save_document)
 * answered from the fixture Northbeam catalog instead of a live GMS.
 * Lets the whole app run with zero DataHub setup (DEMO_MODE=true).
 *
 * NOTE — this fixture is not tool-for-tool identical to the real server, and the
 * difference is deliberate rather than hidden. `mcp-server-datahub` 0.6.0 exposes
 * 20 tools; two of the 7 below have no equivalent on it:
 *
 *   - `get_dataset_health` — the real server inlines a `health` array (and
 *     `deprecation`) on the entity returned by `get_entities` instead.
 *   - `get_usage_stats`    — the real server exposes no usage tool at all, and
 *     doesn't inline query counts either. Filed upstream; see
 *     `submission/oss/issues/01-no-usage-statistics-tool.md`.
 *
 * They are kept here because the fixture predates the live integration and the
 * shapes are useful for unit tests. Everything that consumes them reads the
 * inlined `health` first and treats the tool as an optional refinement — see
 * `snapshotEntity` in `lib/decay.ts` — which is why the same code path works
 * unchanged against a real DataHub, where neither tool exists.
 */

export const DEMO_TOOLS: ToolDef[] = [
  {
    name: "search",
    description:
      "Search the DataHub catalog for datasets, glossary terms, and users. Matches names, descriptions, column names/descriptions, tags, glossary terms, domains, and owners.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text search query, e.g. 'revenue' or 'churn'." },
        entity_type: {
          type: "string",
          description: "Optional filter: dataset | glossaryTerm | corpuser | document.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_entities",
    description:
      "Fetch full details for one or more entities by URN: description, schema fields, owners, tags, glossary terms, and domain.",
    inputSchema: {
      type: "object",
      properties: {
        urns: { type: "array", items: { type: "string" }, description: "Entity URNs to fetch." },
      },
      required: ["urns"],
    },
  },
  {
    name: "get_lineage",
    description:
      "Get upstream (sources) or downstream (consumers) lineage for a dataset URN, up to max_hops away.",
    inputSchema: {
      type: "object",
      properties: {
        urn: { type: "string", description: "Dataset URN." },
        direction: { type: "string", enum: ["upstream", "downstream"], description: "Which direction to traverse." },
        max_hops: { type: "number", description: "How many hops to traverse (default 1, max 3)." },
      },
      required: ["urn", "direction"],
    },
  },
  {
    name: "get_dataset_queries",
    description: "Get saved/observed SQL queries that read a given dataset URN.",
    inputSchema: {
      type: "object",
      properties: {
        urn: { type: "string", description: "Dataset URN." },
      },
      required: ["urn"],
    },
  },
  {
    name: "save_document",
    description:
      "Save a document into the DataHub catalog so others can find it. document_type is one of: Note, LearningPath, Runbook, DescriptionProposal (use DescriptionProposal when you drafted a description/definition to fill a documentation gap you noticed — set subject_urn to the entity it's about).",
    inputSchema: {
      type: "object",
      properties: {
        document_type: { type: "string", description: "Document subtype, e.g. Note, DescriptionProposal." },
        title: { type: "string" },
        content: { type: "string", description: "Markdown content." },
        topics: { type: "array", items: { type: "string" } },
        subject_urn: { type: "string", description: "URN of the entity this document is about, if any (required for DescriptionProposal)." },
      },
      required: ["document_type", "title", "content"],
    },
  },
  {
    name: "get_dataset_health",
    description:
      "Get data-quality signals for a dataset: open incidents, assertion (freshness/volume) pass/fail status, and deprecation status. Check this before recommending a table, and always check it when asked if a table is reliable/healthy/safe to use.",
    inputSchema: {
      type: "object",
      properties: {
        urn: { type: "string", description: "Dataset URN." },
      },
      required: ["urn"],
    },
  },
  {
    name: "get_usage_stats",
    description:
      "Get query usage stats for a dataset over the last 30 days: query count, top users, and trend. Use this to judge how central a table actually is — real usage is a stronger signal of importance than catalog structure alone.",
    inputSchema: {
      type: "object",
      properties: {
        urn: { type: "string", description: "Dataset URN." },
      },
      required: ["urn"],
    },
  },
];

interface DemoDocument {
  urn: string;
  documentType: string;
  title: string;
  content: string;
  topics: string[];
  subjectUrn?: string;
}

// Documents saved during the demo session — survives dev-mode module reloads.
const g = globalThis as unknown as { __demoDocs?: DemoDocument[] };
const savedDocs: DemoDocument[] = (g.__demoDocs ??= []);

const byUrn = new Map(DEMO_DATASETS.map((d) => [d.urn, d]));

function ownerLine(username: string): string {
  const u = DEMO_USERS[username];
  return u ? `${u.name} (${u.title}, urn:li:corpuser:${username})` : `urn:li:corpuser:${username}`;
}

function datasetSummary(d: DemoDataset) {
  return {
    urn: d.urn,
    type: "dataset",
    name: d.name,
    platform: d.platform,
    description: d.description,
    domain: d.domain,
    owners: d.owners.map(ownerLine),
    tags: d.tags,
    glossaryTerms: d.terms,
    ...(d.deprecated
      ? {
          deprecated: {
            since: d.deprecated.since,
            reason: d.deprecated.reason,
            ...(d.deprecated.replacement ? { replacement: d.deprecated.replacement } : {}),
          },
        }
      : {}),
    ...(d.incidents?.some((i) => i.status === "open")
      ? { openIncidents: d.incidents.filter((i) => i.status === "open") }
      : {}),
  };
}

function datasetDetail(d: DemoDataset) {
  return {
    ...datasetSummary(d),
    schema: d.fields.map((f) => ({
      fieldPath: f.fieldPath,
      type: f.nativeDataType,
      description: f.description,
      ...(f.pii ? { tags: ["PII"] } : {}),
      ...(f.terms?.length ? { glossaryTerms: f.terms } : {}),
    })),
  };
}

function searchable(d: DemoDataset): string {
  return [
    d.name,
    d.description,
    d.domain,
    d.platform,
    d.tags.join(" "),
    d.terms.join(" "),
    d.owners.map((o) => `${o} ${DEMO_USERS[o]?.name ?? ""}`).join(" "),
    d.fields.map((f) => `${f.fieldPath} ${f.description} ${(f.terms ?? []).join(" ")}`).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

function demoSearch(args: Record<string, unknown>): unknown {
  const query = String(args.query ?? "").trim();
  const entityType = args.entity_type ? String(args.entity_type).toLowerCase() : null;
  const tokens = tokenize(query);

  const results: unknown[] = [];

  if (!entityType || entityType === "dataset") {
    const scored = DEMO_DATASETS.map((d) => {
      const blob = searchable(d);
      let score = tokens.filter((t) => blob.includes(t)).length;
      if (tokens.some((t) => d.name.toLowerCase().includes(t))) score += 2;
      return { d, score };
    })
      .filter((s) => s.score > 0 || tokens.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    results.push(...scored.map((s) => datasetSummary(s.d)));
  }

  if (!entityType || entityType === "glossaryterm") {
    for (const [key, term] of Object.entries(DEMO_TERMS)) {
      const blob = `${key} ${term.name} ${term.definition}`.toLowerCase();
      if (tokens.some((t) => blob.includes(t))) {
        results.push({
          urn: `urn:li:glossaryTerm:${key}`,
          type: "glossaryTerm",
          name: term.name,
          definition: term.definition,
          relatedTerms: term.related ?? [],
        });
      }
    }
  }

  if (!entityType || entityType === "corpuser") {
    for (const [username, u] of Object.entries(DEMO_USERS)) {
      const blob = `${username} ${u.name} ${u.title}`.toLowerCase();
      if (tokens.some((t) => blob.includes(t))) {
        results.push({
          urn: `urn:li:corpuser:${username}`,
          type: "corpuser",
          name: u.name,
          title: u.title,
          email: u.email,
        });
      }
    }
  }

  if (!entityType || entityType === "document") {
    for (const doc of savedDocs) {
      const blob = `${doc.title} ${doc.content} ${doc.topics.join(" ")}`.toLowerCase();
      if (tokens.some((t) => blob.includes(t))) {
        results.push({
          urn: doc.urn,
          type: "document",
          documentType: doc.documentType,
          title: doc.title,
          topics: doc.topics,
        });
      }
    }
  }

  return { query, totalResults: results.length, results };
}

function demoGetEntities(args: Record<string, unknown>): unknown {
  const urns = Array.isArray(args.urns) ? args.urns.map(String) : [String(args.urn ?? "")];
  return {
    entities: urns.map((urn) => {
      const dataset = byUrn.get(urn);
      if (dataset) return datasetDetail(dataset);

      const termKey = urn.replace("urn:li:glossaryTerm:", "");
      if (urn.startsWith("urn:li:glossaryTerm:") && DEMO_TERMS[termKey]) {
        const term = DEMO_TERMS[termKey];
        return {
          urn,
          type: "glossaryTerm",
          name: term.name,
          definition: term.definition,
          relatedTerms: term.related ?? [],
        };
      }

      const username = urn.replace("urn:li:corpuser:", "");
      if (urn.startsWith("urn:li:corpuser:") && DEMO_USERS[username]) {
        return { urn, type: "corpuser", ...DEMO_USERS[username] };
      }

      const tagKey = urn.replace("urn:li:tag:", "");
      if (urn.startsWith("urn:li:tag:") && DEMO_TAGS[tagKey]) {
        return { urn, type: "tag", name: tagKey, description: DEMO_TAGS[tagKey] };
      }

      const domainKey = urn.replace("urn:li:domain:", "");
      if (urn.startsWith("urn:li:domain:") && DEMO_DOMAINS[domainKey]) {
        return { urn, type: "domain", name: domainKey, description: DEMO_DOMAINS[domainKey] };
      }

      const doc = savedDocs.find((d) => d.urn === urn);
      if (doc) return { type: "document", ...doc };

      return { urn, error: "Entity not found in catalog." };
    }),
  };
}

const downstreamOf = new Map<string, string[]>();
for (const [downstream, upstreams] of Object.entries(DEMO_LINEAGE)) {
  for (const up of upstreams) {
    downstreamOf.set(up, [...(downstreamOf.get(up) ?? []), downstream]);
  }
}

function demoGetLineage(args: Record<string, unknown>): unknown {
  const urn = String(args.urn ?? "");
  const direction = String(args.direction ?? "upstream") as "upstream" | "downstream";
  const maxHops = Math.min(Number(args.max_hops) || 1, 3);

  if (!byUrn.has(urn)) return { urn, error: "Dataset not found in catalog." };

  const edges = direction === "upstream" ? (u: string) => DEMO_LINEAGE[u] ?? [] : (u: string) => downstreamOf.get(u) ?? [];

  const seen = new Set<string>([urn]);
  const hops: { hop: number; entities: unknown[] }[] = [];
  let frontier = [urn];
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const u of frontier) {
      for (const neighbor of edges(u)) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    if (next.length) {
      hops.push({
        hop,
        entities: next.map((u) => {
          const d = byUrn.get(u);
          return d ? datasetSummary(d) : { urn: u };
        }),
      });
    }
    frontier = next;
  }

  return { urn, direction, maxHops, hops, totalEntities: seen.size - 1 };
}

function demoGetDatasetQueries(args: Record<string, unknown>): unknown {
  const urn = String(args.urn ?? "");
  const queries = DEMO_QUERIES.filter((q) => q.subjects.includes(urn)).map((q) => ({
    name: q.name,
    description: q.description,
    language: "SQL",
    statement: q.sql,
  }));
  return { urn, totalQueries: queries.length, queries };
}

function demoSaveDocument(args: Record<string, unknown>): unknown {
  const title = String(args.title ?? "");
  const subjectUrn = args.subject_urn ? String(args.subject_urn) : undefined;
  const doc: DemoDocument = {
    urn: `urn:li:document:demo-${savedDocs.length + 1}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
    documentType: String(args.document_type ?? "Note"),
    title,
    content: String(args.content ?? ""),
    topics: Array.isArray(args.topics) ? args.topics.map(String) : [],
    ...(subjectUrn ? { subjectUrn } : {}),
  };
  savedDocs.push(doc);
  return {
    success: true,
    urn: doc.urn,
    message: `Saved "${doc.title}" to the catalog (demo mode: kept in memory, discoverable via search)${subjectUrn ? `, linked to ${subjectUrn}` : ""}.`,
  };
}

function demoGetDatasetHealth(args: Record<string, unknown>): unknown {
  const urn = String(args.urn ?? "");
  const d = byUrn.get(urn);
  if (!d) return { urn, error: "Dataset not found in catalog." };
  return {
    urn,
    deprecated: d.deprecated ?? null,
    incidents: d.incidents ?? [],
    assertions: d.assertions ?? [],
    healthy: !d.deprecated && !(d.incidents ?? []).some((i) => i.status === "open") && !(d.assertions ?? []).some((a) => a.status === "fail"),
  };
}

function demoGetUsageStats(args: Record<string, unknown>): unknown {
  const urn = String(args.urn ?? "");
  const d = byUrn.get(urn);
  if (!d) return { urn, error: "Dataset not found in catalog." };
  return {
    urn,
    usage: d.usage ?? { queryCount30d: 0, topUsers: [], trend: "flat" },
  };
}

export function callDemoTool(
  name: string,
  args: Record<string, unknown>
): { content: string; isError: boolean } {
  try {
    let result: unknown;
    switch (name) {
      case "search":
        result = demoSearch(args);
        break;
      case "get_entities":
        result = demoGetEntities(args);
        break;
      case "get_lineage":
        result = demoGetLineage(args);
        break;
      case "get_dataset_queries":
        result = demoGetDatasetQueries(args);
        break;
      case "save_document":
        result = demoSaveDocument(args);
        break;
      case "get_dataset_health":
        result = demoGetDatasetHealth(args);
        break;
      case "get_usage_stats":
        result = demoGetUsageStats(args);
        break;
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
    return { content: JSON.stringify(result, null, 2), isError: false };
  } catch (err) {
    return { content: `Demo tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
