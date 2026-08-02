/**
 * Zero-key replay.
 *
 * The hosted demo used to ask a judge to paste their own LLM key before
 * anything happened. Small ask. Still the wrong first thing to put in front of
 * somebody who has five minutes and a tab open.
 *
 * So a handful of real sessions are recorded and committed. When the server has
 * no LLM key configured and the visitor hasn't supplied one, a recognised
 * question replays its recording. What comes back is the NDJSON event stream the
 * live agent produced, so the tool trace expands, the MCP calls and their results
 * sit inside it, and the answer streams in. The UI fakes nothing. Every event in
 * `data/replay/session.json` came out of `lib/agent.ts`, and
 * `npm run capture:replay` records them again.
 *
 * Anything not in the recording still asks for a key, and says so plainly. A
 * replayed answer is labelled as replayed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentEvent } from "./types";

export interface ReplayTurn {
  id: string;
  question: string;
  /** Other phrasings that should match this recording. */
  aliases?: string[];
  /** Every event the live agent emitted, in order. */
  events: AgentEvent[];
}

export interface ReplaySession {
  capturedAt: string;
  model: string;
  catalog: string;
  turns: ReplayTurn[];
}

let cached: ReplaySession | null = null;

export function loadReplaySession(): ReplaySession | null {
  if (cached) return cached;
  try {
    const file = path.join(process.cwd(), "data", "replay", "session.json");
    cached = JSON.parse(readFileSync(file, "utf8")) as ReplaySession;
    return cached;
  } catch {
    return null;
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Jaccard overlap on word sets. Cheap, forgiving of rephrasing, needs no model. */
function similarity(a: string, b: string): number {
  const setA = new Set(normalize(a).split(" ").filter(Boolean));
  const setB = new Set(normalize(b).split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  return shared / new Set([...setA, ...setB]).size;
}

/**
 * Find the recorded turn that answers this question. Exact (normalized) match
 * wins; otherwise the best fuzzy match above a threshold, so "who owns
 * payments?" still finds "Who owns the payments pipeline?".
 */
export function findReplayTurn(question: string): ReplayTurn | null {
  const session = loadReplaySession();
  if (!session) return null;

  const target = normalize(question);
  for (const turn of session.turns) {
    if (normalize(turn.question) === target) return turn;
    if (turn.aliases?.some((a) => normalize(a) === target)) return turn;
  }

  let best: { turn: ReplayTurn; score: number } | null = null;
  for (const turn of session.turns) {
    const score = Math.max(
      similarity(question, turn.question),
      ...(turn.aliases ?? []).map((a) => similarity(question, a))
    );
    if (!best || score > best.score) best = { turn, score };
  }
  return best && best.score >= 0.5 ? best.turn : null;
}

/** The questions the UI should offer, since only these can be replayed. */
export function replayQuestions(): string[] {
  return loadReplaySession()?.turns.map((t) => t.question) ?? [];
}

/**
 * Stream a recorded turn back as NDJSON, pacing it so the tool trace unfolds
 * the way it did live rather than landing in one frame.
 */
export function replayStreamResponse(turn: ReplayTurn): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

      for (const event of turn.events) {
        if (event.type === "done") continue;
        send(event);
        // Tool calls took real seconds live; a little pacing keeps the trace legible.
        await pause(event.type === "tool_call" ? 320 : event.type === "tool_result" ? 180 : 120);
      }
      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      // The client surfaces this so a replayed answer is never mistaken for a live one.
      "X-Instaboard-Replay": turn.id,
    },
  });
}
