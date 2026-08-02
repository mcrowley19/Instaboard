/**
 * The control that isolates what the *catalog* buys you, as opposed to what
 * *having tools at all* buys you.
 *
 * The original benchmark had two arms: the agent with DataHub's MCP tools, and
 * the agent with nothing. A fair reader objects that the gap between them partly
 * measures tools versus no tools. An assistant that can look *anything* up beats
 * one answering from memory, whatever it is looking at.
 *
 * So this is a third arm: the same agent, connected to the warehouse the way an
 * engineer would connect to it without a catalog. `information_schema`, in other
 * words — table names, column names, column types, and nothing else. It is the
 * honest "we don't have DataHub, we have a database connection" counterfactual,
 * and it is what most teams actually have.
 *
 * What it deliberately withholds is everything a catalog adds on top of the
 * schema: owners, glossary definitions, deprecation status, health, usage,
 * lineage, saved queries, documentation, tags, domains. A question this arm can
 * answer is a question you did not need DataHub for.
 *
 * The tables come from the same catalog the grounded arm reads, stripped to what
 * a warehouse would return. That matters: if this arm ran off a different, poorer
 * source, its lower score would be an artifact of the harness rather than a
 * finding about metadata.
 */

import { DEMO_DATASETS } from "./demo-catalog";
import { datahubGraphQL } from "./datahub-graphql";
import { isDemoMode } from "./mcp";
import type { ToolDef } from "./types";

/* ── The shape a warehouse would give you ─────────────────────────────── */

export interface WarehouseColumn {
  column_name: string;
  data_type: string;
}

export interface WarehouseTable {
  /** `platform.schema.table`, as it would appear in a `USE`/`FROM` clause. */
  table_name: string;
  platform: string;
  columns: WarehouseColumn[];
}

/** `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)` → parts. */
function parseDatasetUrn(urn: string): { platform: string; name: string } | null {
  const match = urn.match(/urn:li:dataset:\(urn:li:dataPlatform:([^,]+),([^,]+),[^)]*\)/);
  return match ? { platform: match[1], name: match[2] } : null;
}

/* ── Sources ──────────────────────────────────────────────────────────── */

function fromDemoCatalog(): WarehouseTable[] {
  return DEMO_DATASETS.map((d) => ({
    table_name: parseDatasetUrn(d.urn)?.name ?? d.name,
    platform: d.platform,
    // Names and types only. No descriptions, no PII flags, no glossary terms —
    // a warehouse does not carry them.
    columns: d.fields.map((f) => ({ column_name: f.fieldPath, data_type: f.nativeDataType })),
  }));
}

const LIST_SCHEMAS = `
  query($start: Int!, $count: Int!) {
    search(input: { type: DATASET, query: "*", start: $start, count: $count }) {
      total
      searchResults {
        entity {
          urn
          ... on Dataset {
            schemaMetadata { fields { fieldPath nativeDataType } }
          }
        }
      }
    }
  }
`;

/**
 * Read the live catalog and throw away everything a database connection would
 * not have known. Same source as the grounded arm, so the only variable between
 * the two is how much of it the agent gets to see.
 */
async function fromLiveCatalog(): Promise<WarehouseTable[]> {
  const tables: WarehouseTable[] = [];
  const pageSize = 200;

  for (let start = 0; start < 2_000; start += pageSize) {
    const res = await datahubGraphQL<{
      search: {
        total: number;
        searchResults: {
          entity: { urn: string; schemaMetadata?: { fields: { fieldPath: string; nativeDataType?: string }[] } | null };
        }[];
      } | null;
    }>(LIST_SCHEMAS, { start, count: pageSize });

    const results = res.data?.search?.searchResults ?? [];
    for (const { entity } of results) {
      const parsed = parseDatasetUrn(entity.urn);
      if (!parsed) continue;
      tables.push({
        table_name: parsed.name,
        platform: parsed.platform,
        columns: (entity.schemaMetadata?.fields ?? []).map((f) => ({
          column_name: f.fieldPath,
          data_type: f.nativeDataType || "unknown",
        })),
      });
    }
    if (start + pageSize >= (res.data?.search?.total ?? 0)) break;
  }

  return tables;
}

let cached: WarehouseTable[] | null = null;

export async function warehouseTables(): Promise<WarehouseTable[]> {
  if (cached) return cached;
  cached = isDemoMode() ? fromDemoCatalog() : await fromLiveCatalog();
  return cached;
}

/** Test seam — lets a test install a fixture without a catalog behind it. */
export function __setWarehouseTables(tables: WarehouseTable[] | null): void {
  cached = tables;
}

/* ── The tools the arm gets ───────────────────────────────────────────── */

export const WAREHOUSE_TOOLS: ToolDef[] = [
  {
    name: "list_tables",
    description:
      "List the tables available in the warehouse, with their fully-qualified names. " +
      "Equivalent to querying information_schema.tables. Optionally filter by a substring of the name.",
    inputSchema: {
      type: "object",
      properties: {
        name_contains: { type: "string", description: "Case-insensitive substring of the table name" },
      },
    },
  },
  {
    name: "describe_table",
    description:
      "Return the columns and column types of a table. Equivalent to DESCRIBE TABLE, or querying " +
      "information_schema.columns. Accepts a fully-qualified or partial table name.",
    inputSchema: {
      type: "object",
      properties: { table_name: { type: "string", description: "Table name, fully qualified or a unique suffix" } },
      required: ["table_name"],
    },
  },
  {
    name: "search_columns",
    description:
      "Find tables that have a column whose name contains the given substring. Equivalent to querying " +
      "information_schema.columns with a LIKE predicate.",
    inputSchema: {
      type: "object",
      properties: { column_contains: { type: "string", description: "Case-insensitive substring of a column name" } },
      required: ["column_contains"],
    },
  },
];

function matchesTable(table: WarehouseTable, query: string): boolean {
  const q = query.toLowerCase();
  const name = table.table_name.toLowerCase();
  return name === q || name.endsWith(`.${q}`) || name.includes(q);
}

export async function callWarehouseTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: string; isError: boolean }> {
  const tables = await warehouseTables();

  switch (name) {
    case "list_tables": {
      const filter = typeof args.name_contains === "string" ? args.name_contains.toLowerCase() : "";
      const matched = tables.filter((t) => !filter || t.table_name.toLowerCase().includes(filter));
      return {
        content: JSON.stringify(
          {
            total: matched.length,
            tables: matched.map((t) => ({ table_name: t.table_name, platform: t.platform, columns: t.columns.length })),
          },
          null,
          2
        ),
        isError: false,
      };
    }

    case "describe_table": {
      const wanted = String(args.table_name ?? "");
      const matched = tables.filter((t) => matchesTable(t, wanted));
      if (matched.length === 0) {
        return { content: JSON.stringify({ error: `No table named '${wanted}' exists in the warehouse.` }), isError: false };
      }
      return {
        content: JSON.stringify(
          matched.slice(0, 6).map((t) => ({ table_name: t.table_name, platform: t.platform, columns: t.columns })),
          null,
          2
        ),
        isError: false,
      };
    }

    case "search_columns": {
      const needle = String(args.column_contains ?? "").toLowerCase();
      const hits = tables
        .map((t) => ({
          table_name: t.table_name,
          platform: t.platform,
          columns: t.columns.filter((c) => c.column_name.toLowerCase().includes(needle)),
        }))
        .filter((t) => t.columns.length > 0);
      return { content: JSON.stringify({ total: hits.length, tables: hits.slice(0, 40) }, null, 2), isError: false };
    }

    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
}
