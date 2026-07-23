"use client";

import type { LLMConfig, ProviderName } from "./types";

const STORAGE_KEY = "instaboard.llm";

export function loadLLMSettings(): LLMConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LLMConfig;
    if (!parsed.provider || !parsed.apiKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveLLMSettings(config: LLMConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearLLMSettings(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Headers to attach to API calls; server falls back to .env.local if absent. */
export function llmHeaders(): Record<string, string> {
  const config = loadLLMSettings();
  if (!config) return {};
  const headers: Record<string, string> = {
    "x-llm-provider": config.provider,
    "x-llm-key": config.apiKey,
  };
  if (config.model) headers["x-llm-model"] = config.model;
  return headers;
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Anthropic (Claude)",
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
};
