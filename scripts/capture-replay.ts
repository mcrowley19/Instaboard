/**
 * Record a real agent session for zero-key replay.
 *
 *   npm run capture:replay
 *
 * Runs the questions below through the actual agent loop and writes every event
 * it emits, covering tool calls, tool results and streamed text, into
 * `data/replay/session.json`. The hosted demo serves those recordings when no LLM
 * key is configured, so a visitor gets the product on arrival rather than a key
 * prompt.
 *
 * Recorded in DEMO_MODE by default, against the same built-in Northbeam fixture
 * the hosted demo serves, so the replayed tool results match what a live run on
 * that deployment would return. Pass `--live` to record against real DataHub.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAgent } from "../lib/agent";
import { CHAT_SYSTEM_PROMPT } from "../lib/prompts";
import type { AgentEvent, LLMConfig } from "../lib/types";
import type { ReplaySession, ReplayTurn } from "../lib/replay";

/**
 * The questions worth recording: one per capability the submission claims, and
 * including both traps on purpose. The deprecated table and the dataset that
 * does not exist are the two answers a sceptical reader most wants to watch the
 * agent produce.
 */
const QUESTIONS: { id: string; question: string; aliases?: string[] }[] = [
  {
    id: "revenue-tables",
    question: "What tables do we use for revenue?",
    aliases: ["which revenue tables should I use", "where is revenue data"],
  },
  {
    id: "payments-owner",
    question: "Who owns the payments pipeline?",
    aliases: ["who should I ask about payments", "who owns payments"],
  },
  {
    id: "mrr-definition",
    question: "How do we calculate MRR?",
    aliases: ["what is our MRR definition", "how is MRR computed here"],
  },
  {
    id: "email-blast-radius",
    question: "What breaks if I change users.email?",
    aliases: ["what depends on the email column", "impact of changing users.email"],
  },
  {
    id: "churn-sql",
    question: "Show me the SQL people here use for churn analysis",
    aliases: ["churn SQL", "how do I query churn"],
  },
  {
    id: "health-trap",
    question: "Is it safe to build a new engagement report on the raw events table?",
    aliases: ["can I use the events table", "should I build on raw events"],
  },
  {
    id: "hallucination-trap",
    question: "What columns are in our marketing_attribution table?",
    aliases: ["describe marketing_attribution", "schema of marketing_attribution"],
  },
];

function loadDotEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(path.join(process.cwd(), file), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      /* absent, which is fine */
    }
  }
}

async function main() {
  loadDotEnv();
  const live = process.argv.includes("--live");
  if (!live) process.env.DEMO_MODE = "true";

  const provider = process.env.LLM_PROVIDER as LLMConfig["provider"];
  const apiKey = process.env.LLM_API_KEY;
  if (!provider || !apiKey) {
    console.error("\n  Set LLM_PROVIDER and LLM_API_KEY in .env.local to record a session.\n");
    process.exit(1);
  }
  const config: LLMConfig = { provider, apiKey, model: process.env.LLM_MODEL || undefined };

  const outFile = path.join(process.cwd(), "data", "replay", "session.json");

  // Resume-friendly: keep turns already recorded on this model so a provider
  // quota wall pauses the capture instead of losing it.
  let existing: ReplaySession | null = null;
  try {
    existing = JSON.parse(readFileSync(outFile, "utf8")) as ReplaySession;
  } catch {
    /* first run */
  }
  const model = config.model || `${config.provider} default`;
  const keep = existing?.model === model ? existing.turns : [];

  const turns: ReplayTurn[] = [];
  for (const q of QUESTIONS) {
    const already = keep.find((t) => t.id === q.id);
    if (already) {
      turns.push({ ...already, question: q.question, aliases: q.aliases });
      console.log(`· ${q.id} (already recorded)`);
      continue;
    }

    // Free tiers drop responses; a flake on one question shouldn't cost the run.
    let events: AgentEvent[] = [];
    let answered = false;
    for (let attempt = 1; attempt <= 3 && !answered; attempt++) {
      events = [];
      try {
        await runAgent(config, CHAT_SYSTEM_PROMPT, [{ role: "user", content: q.question }], (e) => events.push(e));
      } catch (err) {
        console.error(`  ${q.id}: attempt ${attempt} failed. ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      answered = events.some((e) => e.type === "text" && e.text.trim());
      if (!answered) console.error(`  ${q.id}: attempt ${attempt} produced no answer`);
    }
    if (!answered) {
      console.error(`✗ ${q.id}: gave up after 3 attempts, not recording`);
      continue;
    }

    turns.push({ id: q.id, question: q.question, aliases: q.aliases, events });
    const toolCalls = events.filter((e) => e.type === "tool_call").length;
    console.log(`✓ ${q.id}: ${events.length} events, ${toolCalls} DataHub calls`);

    // Persist incrementally.
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          model,
          catalog: live ? "live DataHub" : "Northbeam demo fixture",
          turns,
        } satisfies ReplaySession,
        null,
        2
      )
    );
  }

  console.log(`\nrecorded ${turns.length}/${QUESTIONS.length} turns → ${path.relative(process.cwd(), outFile)}`);
  process.exit(turns.length === QUESTIONS.length ? 0 : 2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
