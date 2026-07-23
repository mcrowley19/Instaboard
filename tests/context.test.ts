import { describe, expect, it } from "vitest";
import { CHAT_SYSTEM_PROMPT, pageContextBlock } from "@/lib/prompts";

describe("pageContextBlock (extension context)", () => {
  it("returns empty string when there is no usable context", () => {
    expect(pageContextBlock(undefined)).toBe("");
    expect(pageContextBlock({})).toBe("");
    expect(pageContextBlock({ title: "just a title" })).toBe("");
  });

  it("renders url, title, urn, and selection into the system prompt", () => {
    const urn = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)";
    const block = pageContextBlock({
      url: `http://localhost:9002/dataset/${encodeURIComponent(urn)}/Schema`,
      title: "fct_revenue | DataHub",
      datasetUrn: urn,
      entityType: "dataset",
      selection: "net_amount_usd",
    });

    expect(block).toContain("## Current page context");
    expect(block).toContain(urn);
    expect(block).toContain("fct_revenue | DataHub");
    expect(block).toContain("net_amount_usd");
    // Composes cleanly onto the base prompt.
    expect((CHAT_SYSTEM_PROMPT + block).startsWith("You are instaboard")).toBe(true);
  });

  it("truncates very long selections", () => {
    const block = pageContextBlock({ url: "http://x", selection: "a".repeat(5000) });
    expect(block.length).toBeLessThan(2500);
  });
});
