"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import ToolTrace, { type TraceEntry } from "@/components/ToolTrace";
import { llmHeaders } from "@/lib/settings";
import { streamAgent } from "@/lib/stream-client";
import type { ChatMessage } from "@/lib/types";

type Block = { type: "text"; text: string } | { type: "trace"; entry: TraceEntry };

interface DisplayMessage {
  role: "user" | "assistant";
  blocks: Block[];
}

const SUGGESTIONS = [
  "What tables do we use for revenue?",
  "Who owns the payments pipeline?",
  "How do we calculate MRR?",
  "What breaks if I change users.email?",
  "Show me SQL for churn analysis",
];

export default function ChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const historyFor = (msgs: DisplayMessage[]): ChatMessage[] =>
    msgs.map((m) => ({
      role: m.role,
      content: m.blocks
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    }));

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setError(null);
    setInput("");

    const userMessage: DisplayMessage = { role: "user", blocks: [{ type: "text", text: trimmed }] };
    const assistantMessage: DisplayMessage = { role: "assistant", blocks: [] };
    const nextMessages = [...messages, userMessage];
    setMessages([...nextMessages, assistantMessage]);
    setBusy(true);

    try {
      await streamAgent(
        "/api/chat",
        { messages: historyFor(nextMessages) },
        llmHeaders(),
        (event) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            const blocks = [...last.blocks];

            if (event.type === "text") {
              blocks.push({ type: "text", text: event.text });
            } else if (event.type === "tool_call") {
              blocks.push({
                type: "trace",
                entry: { id: event.id, name: event.name, args: event.args, pending: true },
              });
            } else if (event.type === "tool_result") {
              const idx = blocks.findIndex((b) => b.type === "trace" && b.entry.id === event.id);
              if (idx >= 0) {
                const trace = blocks[idx] as Extract<Block, { type: "trace" }>;
                blocks[idx] = {
                  type: "trace",
                  entry: { ...trace.entry, result: event.result, isError: event.isError, pending: false },
                };
              }
            } else if (event.type === "error") {
              setError(event.message);
            }

            last.blocks = blocks;
            updated[updated.length - 1] = last;
            return updated;
          });
        }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Drop the empty assistant bubble if nothing arrived.
      setMessages((prev) =>
        prev[prev.length - 1]?.blocks.length === 0 ? prev.slice(0, -1) : prev
      );
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  return (
    <div className="chat-wrap">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {messages.length === 0 ? (
            <div className="empty-state" style={{ minHeight: "60vh" }}>
              <h2>Ask your data catalog anything</h2>
              <p>
                instaboard answers from your live DataHub metadata — tables, owners, lineage,
                glossary terms, and real SQL. Perfect for your first week.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="msg-role">{m.role === "user" ? "You" : "instaboard"}</div>
                <div className="msg-body">
                  {m.blocks.map((b, j) =>
                    b.type === "text" ? (
                      <Markdown key={j}>{b.text}</Markdown>
                    ) : (
                      <ToolTrace key={j} entry={b.entry} />
                    )
                  )}
                  {m.role === "assistant" &&
                    busy &&
                    i === messages.length - 1 &&
                    (m.blocks.length === 0 || m.blocks[m.blocks.length - 1].type === "trace") && (
                      <div className="thinking">
                        <span /><span /><span />
                      </div>
                    )}
                </div>
              </div>
            ))
          )}
          {error && <div className="error-banner">{error}</div>}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about tables, owners, metrics, lineage…"
            rows={1}
            disabled={busy}
          />
          <button className="send" onClick={() => send(input)} disabled={busy || !input.trim()} aria-label="Send">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
