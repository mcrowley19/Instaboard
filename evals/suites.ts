/**
 * The two benchmark suites, and what distinguishes them.
 *
 * `northbeam` runs against the catalog this repo seeds. Owning the data means it
 * can test categories a hand-built catalog can express, like usage ranking,
 * deprecation traps and failing assertions, which no public demo catalog carries
 * on an OSS server.
 *
 * `showcase` runs against `showcase-ecommerce`, DataHub's own published demo
 * datapack, holding 1,065 entities nobody here designed. It answers the fair
 * objection that a high score on your own catalog is partly built in.
 *
 * Same agent loop, same deterministic scorer, same two arms. Only the catalog
 * and the questions differ.
 */

import { BENCHMARK, CATEGORIES, type Category, type EvalCase } from "./benchmark";
import { SHOWCASE_BENCHMARK, SHOWCASE_CATEGORIES, type ShowcaseCategory } from "./benchmark-showcase";

export type SuiteName = "northbeam" | "showcase";

export interface Suite {
  name: SuiteName;
  /** Human-readable catalog description for the scorecard header. */
  catalog: string;
  cases: EvalCase<string>[];
  categories: string[];
  /**
   * The control arm's prompt. Deliberately NOT instaboard's system prompt with
   * the tools removed, which would be a strawman that refuses every question.
   * It is the honest counterfactual: a capable general assistant answering a new
   * hire's question with no access to the company's catalog, which is exactly
   * what a new hire gets from an off-the-shelf chatbot today.
   */
  blindPrompt: string;
  /** Basename for results files under evals/results/. */
  resultsPrefix: string;
  /** True when the suite has no demo fixture and must run against live DataHub. */
  requiresLive: boolean;
  /** Shown in the scorecard so readers know how to reproduce it. */
  reproduce: string[];
}

const NORTHBEAM_BLIND = `You are a helpful assistant for a new hire joining a data team at Northbeam, a subscription-commerce company. They will ask you practical questions about the company's data warehouse: which tables to use, who owns them, how metrics are defined, and what SQL to write.

Answer as helpfully and specifically as you can. Give concrete table names, column names, owners, and SQL where relevant — a vague answer is not useful to someone trying to ship their first query this week. Be concise and well structured.`;

const SHOWCASE_BLIND = `You are a helpful assistant for a new hire joining the data team at Acme Corporation, an e-commerce business. Their warehouse is an order-entry system: Postgres sources replicated to S3 and Snowflake, dbt models on top, and Looker, PowerBI and Tableau for reporting. They will ask you practical questions about it: which tables to use, who owns them, how metrics are defined, what is classified as personal data, and what SQL to write.

Answer as helpfully and specifically as you can. Give concrete table names, column names, owners, and SQL where relevant — a vague answer is not useful to someone trying to ship their first query this week. Be concise and well structured.`;

export const SUITES: Record<SuiteName, Suite> = {
  northbeam: {
    name: "northbeam",
    catalog: "Northbeam, seeded by this repo with `npm run seed`",
    cases: BENCHMARK as EvalCase<string>[],
    categories: CATEGORIES as unknown as string[],
    blindPrompt: NORTHBEAM_BLIND,
    resultsPrefix: "",
    requiresLive: false,
    reproduce: [
      "- **Reproduce:** `DEMO_MODE=true npm run eval`, which needs neither DataHub nor Docker.",
      "  Add `--live` to run the same benchmark against a seeded DataHub instance,",
      "  or `--concurrency=1` if your provider is strict about requests per minute.",
    ],
  },
  showcase: {
    name: "showcase",
    catalog: "`showcase-ecommerce`, the demo datapack DataHub publishes (1,065 entities, authored by the DataHub team)",
    cases: SHOWCASE_BENCHMARK as EvalCase<string>[],
    categories: SHOWCASE_CATEGORIES as unknown as string[],
    blindPrompt: SHOWCASE_BLIND,
    resultsPrefix: "showcase-",
    requiresLive: true,
    reproduce: [
      "- **Reproduce:** this suite runs only against live DataHub, because the catalog",
      "  it checks is not ours to fixture:",
      "",
      "  ```bash",
      "  npm run datahub:up",
      "  datahub datapack load showcase-ecommerce   # DataHub's own demo pack",
      "  npm run eval -- --live --suite=showcase",
      "  ```",
      "",
      "- **Nothing here was authored by instaboard.** Every table, owner, glossary",
      "  definition, structured property and lineage edge checked above came out of",
      "  the datapack. The questions were written against facts read back from the",
      "  live catalog after loading it.",
    ],
  },
};

export type { Category, ShowcaseCategory };
