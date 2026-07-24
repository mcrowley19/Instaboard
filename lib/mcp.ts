import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callDemoTool, DEMO_TOOLS } from "./demo-mcp";
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
}

// Survive Next.js dev-mode module reloads by stashing on globalThis.
const g = globalThis as unknown as { __datahubMcp?: McpState };
const state: McpState = (g.__datahubMcp ??= { client: null, connecting: null, tools: null });

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
  if (isDemoMode()) return DEMO_TOOLS;
  if (state.tools) return state.tools;
  const client = await getMcpClient();
  const { tools } = await client.listTools();
  state.tools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
  }));
  return state.tools;
}

const MAX_RESULT_CHARS = 30_000;

/** Call a DataHub MCP tool and return its result flattened to a string. */
export async function callDataHubTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: string; isError: boolean }> {
  if (isDemoMode()) return callDemoTool(name, args);
  const client = await getMcpClient();
  try {
    const result = await client.callTool({ name, arguments: args });
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
export async function mcpStatus(): Promise<{ connected: boolean; toolCount: number; demo?: boolean; error?: string }> {
  try {
    const tools = await listDataHubTools();
    return { connected: true, toolCount: tools.length, ...(isDemoMode() ? { demo: true } : {}) };
  } catch (err) {
    return {
      connected: false,
      toolCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
