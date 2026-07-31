import type { EvalCase } from "./benchmark";

/**
 * Deterministic scoring. Every check is a case-insensitive substring match
 * against the agent's final answer — no LLM judge, no partial credit, no
 * subjective calls. Re-running the harness on the same answers always produces
 * the same score, and any judge can read a failure and verify it by hand.
 */

export interface CheckResult {
  label: string;
  kind: "must-include" | "must-not-include";
  passed: boolean;
  /** For must-not-include failures: what was found. */
  offender?: string;
}

export interface CaseResult {
  id: string;
  category: EvalCase["category"];
  question: string;
  answer: string;
  checks: CheckResult[];
  passed: boolean;
  score: number;
  maxScore: number;
  toolCalls: string[];
  durationMs: number;
  error?: string;
}

function normalize(text: string): string {
  // Collapse whitespace so checks survive line wrapping, and strip markdown
  // emphasis so `**fct_revenue**` still matches "fct_revenue".
  return text.replace(/[*_`]/g, "").replace(/\s+/g, " ").toLowerCase();
}

export function scoreCase(evalCase: EvalCase, answer: string): CheckResult[] {
  const haystack = normalize(answer);
  const checks: CheckResult[] = [];

  for (const group of evalCase.mustInclude) {
    checks.push({
      label: group.label,
      kind: "must-include",
      passed: group.anyOf.some((needle) => haystack.includes(normalize(needle))),
    });
  }

  for (const group of evalCase.mustNotInclude ?? []) {
    const offender = group.anyOf.find((needle) => haystack.includes(normalize(needle)));
    checks.push({
      label: group.label,
      kind: "must-not-include",
      passed: !offender,
      ...(offender ? { offender } : {}),
    });
  }

  return checks;
}

/** A case passes only if every one of its checks passes — all-or-nothing. */
export function summarizeCase(checks: CheckResult[]): { passed: boolean; score: number; maxScore: number } {
  const score = checks.filter((c) => c.passed).length;
  return { passed: score === checks.length, score, maxScore: checks.length };
}
