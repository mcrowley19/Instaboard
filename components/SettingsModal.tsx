"use client";

import { useState } from "react";
import { clearLLMSettings, loadLLMSettings, PROVIDER_LABELS, saveLLMSettings } from "@/lib/settings";
import type { ProviderName } from "@/lib/types";

const MODEL_PLACEHOLDERS: Record<ProviderName, string> = {
  anthropic: "claude-opus-4-8 (default)",
  openrouter: "anthropic/claude-sonnet-4.5 (default)",
  gemini: "gemini-2.5-flash (default)",
};

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const existing = loadLLMSettings();
  const [provider, setProvider] = useState<ProviderName>(existing?.provider ?? "anthropic");
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? "");
  const [model, setModel] = useState(existing?.model ?? "");

  const save = () => {
    if (apiKey.trim()) {
      saveLLMSettings({ provider, apiKey: apiKey.trim(), model: model.trim() || undefined });
    } else {
      clearLLMSettings();
    }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>LLM Settings</h3>
        <p className="sub">
          Your key is stored only in this browser&apos;s localStorage and sent directly to your own
          server — never committed or logged.
        </p>

        <div className="field">
          <label className="label">Provider</label>
          <select className="select" value={provider} onChange={(e) => setProvider(e.target.value as ProviderName)}>
            {(Object.keys(PROVIDER_LABELS) as ProviderName[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label">API Key</label>
          <input
            className="input"
            type="password"
            placeholder={provider === "anthropic" ? "sk-ant-…" : provider === "openrouter" ? "sk-or-…" : "AIza…"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="label">Model (optional)</label>
          <input
            className="input"
            type="text"
            placeholder={MODEL_PLACEHOLDERS[provider]}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        <div className="actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
