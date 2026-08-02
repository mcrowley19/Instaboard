/**
 * Capture what the Chrome side panel actually does, against a live DataHub.
 *
 *   npm run dev                      # backend on :3000, DEMO_MODE unset
 *   npm run receipts:extension
 *
 * The side panel is a thin client. It reads the entity off the DataHub page you
 * are looking at, POSTs that context to `/api/chat` and `/api/handoffs`, and
 * renders whatever streams back. Everything catalog-facing happens on the
 * backend, so the panel's behaviour is fully determined by those two requests.
 *
 * This script sends the exact request bodies `extension/sidepanel.js` builds,
 * with an entity URN taken from DataHub's own showcase-ecommerce datapack, and
 * writes the responses to examples/live/extension-receipt.json. A reader who
 * wants to know whether the panel does what the README says can read that file
 * instead of taking a screenshot's word for it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentEvent } from "../lib/types";

const BACKEND = process.env.INSTABOARD_BACKEND || "http://localhost:3000";
const UI = process.env.DATAHUB_UI_URL || "http://localhost:9002";

/** A showcase-ecommerce entity, so the receipt shows a catalog we did not seed. */
const URN =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,b2fd91.order_entry_db.analytics.order_details,PROD)";
const PAGE_URL = `${UI}/dataset/${encodeURIComponent(URN)}/Schema`;

/** The regex the content script uses, read from the extension so it can't drift. */
function detectEntity(url: string): { entityType?: string; datasetUrn?: string } {
  const script = readFileSync(path.join(process.cwd(), "extension", "content.js"), "utf8");
  const src = script.match(/const URN_ROUTE_RE\s*=\s*([\s\S]*?);\n/);
  if (!src) throw new Error("URN_ROUTE_RE not found in extension/content.js");
  const re = eval(src[1]) as RegExp;
  try {
    const m = decodeURIComponent(url).match(re);
    return m ? { entityType: m[1], datasetUrn: m[2] } : {};
  } catch {
    return {};
  }
}

/**
 * Both endpoints answer with newline-delimited JSON, the same stream the side
 * panel reads. `/api/handoffs` ends with a `result` event carrying the saved
 * runbook.
 */
async function streamNdjson(url: string, body: unknown): Promise<{ events: AgentEvent[]; status: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    return { events: [], status: res.status };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: AgentEvent[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) events.push(JSON.parse(line) as AgentEvent);
    }
  }
  return { events, status: res.status };
}

async function main() {
  const detected = detectEntity(PAGE_URL);
  if (detected.datasetUrn !== URN) {
    console.error("content script did not recover the URN from the page URL");
    process.exit(1);
  }
  console.log(`✓ content script read ${detected.entityType} off the page URL`);

  // Exactly the shape sidepanel.js sends: the typed message, prior turns, and
  // the page context the content script just handed it.
  const chatBody = {
    message: "What is this table, and what should I be careful about before using it?",
    messages: [],
    context: {
      url: PAGE_URL,
      title: "order_details | Model",
      datasetUrn: detected.datasetUrn,
      entityType: detected.entityType,
      selection: "cost_of_delivery",
    },
  };

  // Free-tier providers drop responses. Retry rather than commit an empty receipt.
  let chat = { events: [] as AgentEvent[], status: 0 };
  let answer = "";
  for (let attempt = 1; attempt <= 4 && !answer.trim(); attempt++) {
    // Back off between attempts; retrying immediately just trips the rate limit
    // that swallowed the first response.
    if (attempt > 1) await new Promise((r) => setTimeout(r, attempt * 15_000));
    chat = await streamNdjson(`${BACKEND}/api/chat`, chatBody);
    answer = chat.events
      .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("\n");
    const failed = chat.events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
    if (!answer.trim()) {
      console.log(`  /api/chat attempt ${attempt} produced no answer${failed ? `: ${failed.message.slice(0, 120)}` : ""}`);
    }
  }
  const toolCalls = chat.events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call"
  );
  console.log(`✓ /api/chat answered in ${chat.events.length} events, ${toolCalls.length} DataHub calls`);

  // The record path: the panel POSTs the page trail it captured while the user
  // worked, and the backend turns it into an enriched runbook.
  const handoffBody = {
    title: "Reading the order detail table",
    author: "Michael",
    role: "Analytics Engineer",
    steps: [
      {
        url: PAGE_URL,
        title: "order_details | Model",
        urn: URN,
        entityType: "dataset",
        note: "Start here. This is the certified wide order table, not the replica.",
      },
    ],
  };
  type Runbook = { id: string; steps: unknown[]; snapshots?: Record<string, unknown> };
  let record = { events: [] as AgentEvent[], status: 0 };
  let runbook: Runbook | undefined;
  for (let attempt = 1; attempt <= 3 && !runbook; attempt++) {
    await new Promise((r) => setTimeout(r, attempt * 15_000));
    record = await streamNdjson(`${BACKEND}/api/handoffs`, handoffBody);
    runbook = record.events.find(
      (e): e is Extract<AgentEvent, { type: "result" }> => e.type === "result"
    )?.data as Runbook | undefined;
    if (!runbook) {
      const failed = record.events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
      console.log(
        `  /api/handoffs attempt ${attempt} produced no runbook${failed ? `: ${failed.message.slice(0, 120)}` : ""}`
      );
    }
  }
  console.log(
    `✓ /api/handoffs built a runbook: ${runbook?.steps?.length ?? 0} enriched step(s), ` +
      `${Object.keys(runbook?.snapshots ?? {}).length} entity snapshot(s)`
  );

  const out = {
    capturedAt: new Date().toISOString(),
    backend: BACKEND,
    datahubUi: UI,
    what: "The two requests extension/sidepanel.js makes, run against a live backend and a live DataHub.",
    entityDetection: {
      pageUrl: PAGE_URL,
      detected,
      source: "extension/content.js URN_ROUTE_RE",
    },
    chat: {
      request: chatBody,
      status: chat.status,
      toolCalls: toolCalls.map((t) => ({ name: t.name, args: t.args })),
      answer,
    },
    handoff: {
      request: handoffBody,
      status: record.status,
      toolCalls: record.events
        .filter((e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call")
        .map((t) => ({ name: t.name, args: t.args })),
      runbook,
    },
  };

  const file = path.join(process.cwd(), "examples", "live", "extension-receipt.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), file)}`);

  if (chat.status !== 200 || !answer.trim()) {
    console.error("chat did not produce an answer; is the backend running with an LLM key?");
    process.exit(1);
  }
  if (!runbook) {
    console.error("the record path did not return a runbook");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
