"use client";

import type { AgentEvent } from "./types";

/**
 * POST to an agent endpoint and invoke onEvent for each newline-delimited
 * JSON event as it arrives. Throws on non-2xx (with the server's error text).
 */
export async function streamAgent(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as AgentEvent);
      } catch {
        /* skip malformed line */
      }
    }
  }
  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer) as AgentEvent);
    } catch {
      /* ignore */
    }
  }
}

/** Extract the last ```json fenced block from agent output, parsed. */
export function extractJsonBlock<T>(text: string): T | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = matches.length ? matches[matches.length - 1][1] : null;
  if (!raw) {
    // Fall back: maybe the whole text is JSON.
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
