import { readFileSync } from "node:fs";
import path from "node:path";
import Landing, { type BenchmarkSummary } from "./landing-client";

interface RawCase {
  id: string;
  category: string;
  passed: boolean;
}

interface RawArm {
  arm: "grounded" | "blind";
  cases: RawCase[];
  casesPassed: number;
  toolCalls: number;
}

/**
 * Read the committed benchmark artifact so the front page reports the score we
 * actually measured. If `npm run eval` has never been run the section simply
 * doesn't render — the page is never allowed to invent a number.
 */
function readBenchmark(): BenchmarkSummary | null {
  try {
    const raw = readFileSync(path.join(process.cwd(), "evals", "results", "latest.json"), "utf8");
    const data = JSON.parse(raw) as {
      meta: { model: string; at: string; mode: string };
      arms: RawArm[];
    };

    const grounded = data.arms.find((a) => a.arm === "grounded");
    const blind = data.arms.find((a) => a.arm === "blind");
    if (!grounded || !blind) return null;

    const names = [...new Set(grounded.cases.map((c) => c.category))];
    const categories = names.map((name) => ({
      name,
      total: grounded.cases.filter((c) => c.category === name).length,
      grounded: grounded.cases.filter((c) => c.category === name && c.passed).length,
      blind: blind.cases.filter((c) => c.category === name && c.passed).length,
    }));

    return {
      model: data.meta.model,
      at: data.meta.at,
      total: grounded.cases.length,
      grounded: grounded.casesPassed,
      blind: blind.casesPassed,
      toolCalls: grounded.toolCalls,
      categories,
    };
  } catch {
    return null;
  }
}

export default function Page() {
  return <Landing benchmark={readBenchmark()} />;
}
