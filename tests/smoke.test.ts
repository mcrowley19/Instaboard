import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, LearningPath } from "@/lib/types";

// The MCP layer is mocked in tests — at runtime the app talks to the real
// DataHub MCP server over stdio, which isn't available in CI.
vi.mock("@/lib/mcp", () => ({
  listDataHubTools: vi.fn(async () => [
    {
      name: "search",
      description: "Search DataHub entities",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
    {
      name: "get_lineage",
      description: "Get lineage for an entity",
      inputSchema: { type: "object", properties: { urn: { type: "string" } } },
    },
  ]),
  callDataHubTool: vi.fn(async (name: string) => ({
    content: JSON.stringify({
      results: [
        {
          urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)",
          name: "fct_revenue",
          tool: name,
        },
      ],
    }),
    isError: false,
  })),
  mcpStatus: vi.fn(async () => ({ connected: true, toolCount: 2 })),
}));

vi.mock("@/lib/providers", () => ({
  DEFAULT_MODELS: { anthropic: "claude-opus-4-8" },
  runLLMTurn: vi.fn(),
}));

import { runAgent } from "@/lib/agent";
import { callDataHubTool, listDataHubTools, mcpStatus } from "@/lib/mcp";
import { runLLMTurn } from "@/lib/providers";
import { extractJsonBlock } from "@/lib/stream-client";
import { pathToMarkdown } from "@/lib/path-storage";

const mockedRunLLMTurn = vi.mocked(runLLMTurn);

beforeEach(() => {
  mockedRunLLMTurn.mockReset();
});

describe("MCP client (mocked transport)", () => {
  it("connects and lists DataHub tools", async () => {
    const status = await mcpStatus();
    expect(status.connected).toBe(true);
    expect(status.toolCount).toBeGreaterThan(0);

    const tools = await listDataHubTools();
    expect(tools.map((t) => t.name)).toContain("search");
  });

  it("search returns results containing dataset URNs", async () => {
    const result = await callDataHubTool("search", { query: "revenue" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("urn:li:dataset:");
    expect(result.content).toContain("fct_revenue");
  });
});

describe("agent loop", () => {
  it("executes tool calls and streams events in order", async () => {
    mockedRunLLMTurn
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "t1", name: "search", args: { query: "revenue" } }],
      })
      .mockResolvedValueOnce({
        text: "The revenue table is `fct_revenue`.",
        toolCalls: [],
      });

    const events: AgentEvent[] = [];
    const finalText = await runAgent(
      { provider: "anthropic", apiKey: "test-key" },
      "system prompt",
      [{ role: "user", content: "What tables do we use for revenue?" }],
      (e) => events.push(e)
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(finalText).toContain("fct_revenue");

    const call = events[0] as Extract<AgentEvent, { type: "tool_call" }>;
    expect(call.name).toBe("search");
    expect(call.args).toEqual({ query: "revenue" });
  });

  it("feeds tool results back to the LLM on the next turn", async () => {
    mockedRunLLMTurn
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "t1", name: "search", args: { query: "churn" } }],
      })
      .mockResolvedValueOnce({ text: "done", toolCalls: [] });

    await runAgent(
      { provider: "anthropic", apiKey: "test-key" },
      "system",
      [{ role: "user", content: "hi" }],
      () => {}
    );

    const secondCallTurns = mockedRunLLMTurn.mock.calls[1][2];
    const toolResultTurn = secondCallTurns.find((t) => t.kind === "tool_results");
    expect(toolResultTurn).toBeDefined();
    expect(
      toolResultTurn && toolResultTurn.kind === "tool_results" ? toolResultTurn.results[0].content : ""
    ).toContain("urn:li:dataset:");
  });

  it("stops without tool calls when the LLM answers directly", async () => {
    mockedRunLLMTurn.mockResolvedValueOnce({ text: "Hello!", toolCalls: [] });

    const events: AgentEvent[] = [];
    await runAgent(
      { provider: "anthropic", apiKey: "test-key" },
      "system",
      [{ role: "user", content: "hello" }],
      (e) => events.push(e)
    );

    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(mockedRunLLMTurn).toHaveBeenCalledTimes(1);
  });
});

describe("learning path generation", () => {
  const planJson = {
    role: "Junior Data Analyst",
    domain: "Payments",
    summary: "Week one focuses on the revenue pipeline.",
    days: [
      {
        day: 1,
        title: "Core tables to understand",
        items: [
          {
            title: "fct_revenue",
            detail: "Canonical revenue fact table.",
            urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)",
          },
        ],
      },
    ],
  };

  it("produces a non-empty structured plan from agent output", async () => {
    mockedRunLLMTurn
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "t1", name: "search", args: { query: "payments" } }],
      })
      .mockResolvedValueOnce({
        text: "```json\n" + JSON.stringify(planJson) + "\n```",
        toolCalls: [],
      });

    let output = "";
    await runAgent(
      { provider: "anthropic", apiKey: "test-key" },
      "path prompt",
      [{ role: "user", content: "build the plan" }],
      (e) => {
        if (e.type === "text") output += e.text + "\n";
      }
    );

    const parsed = extractJsonBlock<LearningPath>(output);
    expect(parsed).not.toBeNull();
    expect(parsed!.days.length).toBeGreaterThan(0);
    expect(parsed!.days[0].items[0].urn).toContain("urn:li:dataset:");
  });

  it("renders a plan to markdown for save_document write-back", () => {
    const md = pathToMarkdown(planJson);
    expect(md).toContain("# Week 1 Onboarding — Junior Data Analyst (Payments)");
    expect(md).toContain("## Day 1: Core tables to understand");
    expect(md).toContain("fct_revenue");
  });
});

describe("extractJsonBlock", () => {
  it("parses a fenced json block surrounded by prose", () => {
    const parsed = extractJsonBlock<{ a: number }>('intro\n```json\n{"a": 1}\n```\noutro');
    expect(parsed).toEqual({ a: 1 });
  });

  it("uses the last fenced block when several exist", () => {
    const parsed = extractJsonBlock<{ a: number }>('```json\n{"a": 1}\n```\n```json\n{"a": 2}\n```');
    expect(parsed).toEqual({ a: 2 });
  });

  it("falls back to whole-text JSON", () => {
    expect(extractJsonBlock<{ ok: boolean }>('{"ok": true}')).toEqual({ ok: true });
  });

  it("returns null on garbage", () => {
    expect(extractJsonBlock("not json at all")).toBeNull();
  });
});
