import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callDemoTool, DEMO_TOOLS } from "./demo-mcp";
import { gmsReachable } from "./datahub-graphql";
import { callToolOverGraphQL, GRAPHQL_TOOLS } from "./mcp-over-graphql";
import type { ToolDef } from "./types";

/** Demo mode answers all tools from the fixture Northbeam catalog — no DataHub needed. */
export function isDemoMode(): boolean {
  const v = (process.env.DEMO_MODE || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Singleton connection to the DataHub MCP server (acryl-data/mcp-server-datahub),
 * spawned over stdio via `uvx`. The subprocess talks to DataHub GMS using
 * DATAHUB_GMS_URL / DATAHUB_GMS_TOKEN from the environment.
 */

const MCP_COMMAND = process.env.DATAHUB_MCP_COMMAND || "uvx";
const MCP_ARGS = process.env.DATAHUB_MCP_ARGS
  ? process.env.DATAHUB_MCP_ARGS.split(" ")
  : ["mcp-server-datahub@latest"];

interface McpState {
  client: Client | null;
  connecting: Promise<Client> | null;
  tools: ToolDef[] | null;
  /** Set when the MCP server can't be spawned (e.g. serverless hosts with no
   *  uvx) — the process falls back to the demo catalog instead of erroring. */
  fallbackDemo: boolean;
  /**
   * Set when the subprocess is unavailable but GMS answers over HTTP. The four
   * tools the loop needs then go over GraphQL instead of to the fixture, which
   * is what lets a serverless deployment read and write a real catalog.
   * `null` means not yet determined.
   */
  graphqlTransport: boolean | null;
}

// Survive Next.js dev-mode module reloads by stashing on globalThis.
const g = globalThis as unknown as { __datahubMcp?: McpState };
const state: McpState = (g.__datahubMcp ??= {
  client: null,
  connecting: null,
  tools: null,
  fallbackDemo: false,
  graphqlTransport: null,
});

function demoActive(): boolean {
  return isDemoMode() || state.fallbackDemo;
}

/**
 * Can we reach a real catalog over plain HTTP, having failed to spawn the
 * subprocess? Explicit demo mode is never overridden — being asked for the
 * fixture and answering from a live catalog would be the same class of
 * dishonesty as the reverse.
 */
async function graphqlTransportAvailable(): Promise<boolean> {
  if (isDemoMode()) return false;
  if (state.graphqlTransport !== null) return state.graphqlTransport;
  state.graphqlTransport = await gmsReachable();
  return state.graphqlTransport;
}

async function connect(): Promise<Client> {
  const client = new Client({ name: "instaboard", version: "0.1.0" });

  const transport = new StdioClientTransport({
    command: MCP_COMMAND,
    args: MCP_ARGS,
    env: {
      ...(process.env as Record<string, string>),
      DATAHUB_GMS_URL: process.env.DATAHUB_GMS_URL || "http://localhost:8080",
      DATAHUB_GMS_TOKEN: process.env.DATAHUB_GMS_TOKEN || "",
      // Enable write-back tools (save_document) on the MCP server.
      TOOLS_IS_MUTATION_ENABLED: "true",
    },
    stderr: "ignore",
  });

  transport.onclose = () => {
    state.client = null;
    state.tools = null;
  };

  await client.connect(transport);
  return client;
}

export async function getMcpClient(): Promise<Client> {
  if (state.client) return state.client;
  if (!state.connecting) {
    state.connecting = connect()
      .then((c) => {
        state.client = c;
        return c;
      })
      .finally(() => {
        state.connecting = null;
      });
  }
  return state.connecting;
}

/** List DataHub MCP tools mapped to a provider-neutral shape (cached). */
export async function listDataHubTools(): Promise<ToolDef[]> {
  if (demoActive()) return DEMO_TOOLS;
  if (state.tools) return state.tools;
  let client: Client;
  try {
    client = await getMcpClient();
  } catch {
    // Can't spawn the server at all — serve the demo catalog rather than a
    // dead app. The status pill reports the fallback so it's never ambiguous.
    state.fallbackDemo = true;
    return DEMO_TOOLS;
  }
  const { tools } = await client.listTools();
  state.tools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
  }));
  return state.tools;
}

const MAX_RESULT_CHARS = 30_000;

/**
 * How many catalog reads have been made, by tool.
 *
 * Here so the scale benchmark can report the sweep's cost as a count of calls
 * rather than an estimate of one. Nothing depends on it being reset, and it is
 * never read in the request path.
 */
export const toolCallCounts: Record<string, number> = {};

export function resetToolCallCounts(): void {
  for (const key of Object.keys(toolCallCounts)) delete toolCallCounts[key];
}

/** Call a DataHub MCP tool and return its result flattened to a string. */
export async function callDataHubTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: string; isError: boolean }> {
  toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
  if (isDemoMode()) return callDemoTool(name, args);

  // Already known to have no subprocess: try GraphQL before the fixture. A real
  // catalog answered over HTTP beats a fixture answered perfectly.
  if (state.fallbackDemo && GRAPHQL_TOOLS.has(name) && (await graphqlTransportAvailable())) {
    const viaGraphQL = await callToolOverGraphQL(name, args);
    if (viaGraphQL) return viaGraphQL;
  }
  if (demoActive()) return callDemoTool(name, args);

  let client: Client;
  try {
    client = await getMcpClient();
  } catch {
    state.fallbackDemo = true;
    if (GRAPHQL_TOOLS.has(name) && (await graphqlTransportAvailable())) {
      const viaGraphQL = await callToolOverGraphQL(name, args);
      if (viaGraphQL) return viaGraphQL;
    }
    return callDemoTool(name, args);
  }
  try {
    // A tool call with no deadline can wait forever, and does: the scale
    // benchmark hung here for half an hour against a 10,000-dataset catalog with
    // GMS answering other requests in milliseconds and both processes idle at 0%
    // CPU. Nothing upstream of this imposes a timeout, so an unattended sweep —
    // the cron entry point, the thing meant to run nightly without a human —
    // would have hung until somebody noticed rather than reported a failure.
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: Number(process.env.MCP_TIMEOUT_MS || 120_000) }
    );
    const blocks = Array.isArray(result.content) ? result.content : [];
    let text = blocks
      .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : `[${b.type}]`))
      .join("\n");
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + `\n…[truncated ${text.length - MAX_RESULT_CHARS} chars]`;
    }
    return { content: text || "(empty result)", isError: Boolean(result.isError) };
  } catch (err) {
    // Connection may have died (server restart) — drop it so the next call reconnects.
    state.client = null;
    state.tools = null;
    const message = err instanceof Error ? err.message : String(err);
    return { content: `MCP tool error: ${message}`, isError: true };
  }
}

/** Health probe used by the UI status pill. */
export async function mcpStatus(): Promise<{
  connected: boolean;
  toolCount: number;
  demo?: boolean;
  fallback?: boolean;
  /** True when catalog reads and writes are going over GraphQL, not the fixture. */
  graphql?: boolean;
  catalog?: string;
  error?: string;
}> {
  try {
    const tools = await listDataHubTools();
    // `fallbackDemo` used to mean "answering from the fixture". It now means
    // only "no subprocess", so the pill has to distinguish the two or it will
    // report a live catalog as a demo.
    const overGraphQL = state.fallbackDemo && (await graphqlTransportAvailable());
    return {
      connected: true,
      toolCount: tools.length,
      ...(demoActive() && !overGraphQL ? { demo: true } : {}),
      ...(state.fallbackDemo ? { fallback: true } : {}),
      // The frontend URL where one is set, not the GMS endpoint — see
      // `catalogLabel` in lib/live-demo.ts. A reachable GMS with no auth is a
      // write endpoint, and this response is public.
      ...(overGraphQL
        ? {
            graphql: true,
            catalog:
              process.env.DATAHUB_FRONTEND_URL || process.env.DATAHUB_GMS_URL || "http://localhost:8080",
          }
        : {}),
    };
  } catch (err) {
    return {
      connected: false,
      toolCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
