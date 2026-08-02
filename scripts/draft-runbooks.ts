/**
 * Draft runbooks from what the catalog already knows — no recording required.
 *
 *   npm run draft -- --query=revenue          # best candidates matching a search
 *   npm run draft -- --urn="urn:li:dataset:…" # one specific dataset
 *   npm run draft -- --query=orders --count=5
 *   npm run draft -- --query=revenue --save   # keep them, and write back to DataHub
 *
 * The capture loop needs a departing engineer to sit down and record, which is
 * the scarcest hour in the building. This does not: it reads the recorded
 * queries, the lineage, the ownership and the health that a year-old catalog
 * already holds, and drafts a first pass. The person leaving then corrects a
 * draft rather than facing a blank page.
 *
 * Drafts are marked as drafts everywhere they surface, and every inferred `why`
 * reads as evidence rather than as remembered intent. The one thing a catalog
 * cannot tell you is why step 2 exists, and pretending otherwise would defeat
 * the point of the tool.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { draftForQuery, draftRunbook, evidenceScore, type DraftResult } from "../lib/draft-runbook";
import { handoffToMarkdown, saveHandoff } from "../lib/handoff-store";
import { callDataHubTool, isDemoMode } from "../lib/mcp";

const args = process.argv.slice(2);
const query = args.find((a) => a.startsWith("--query="))?.split("=")[1];
const urn = args.find((a) => a.startsWith("--urn="))?.split("=").slice(1).join("=");
const count = Number(args.find((a) => a.startsWith("--count="))?.split("=")[1] || 3);
const save = args.includes("--save");
const json = args.includes("--json");
const outDir = args.find((a) => a.startsWith("--out="))?.split("=")[1];

function report(draft: DraftResult): void {
  const { handoff, evidence } = draft;
  console.log(`\n📝 ${handoff.title}`);
  console.log(`   ${handoff.steps.length} steps · evidence score ${evidenceScore(evidence)}`);
  console.log(`   basis: ${draft.basis.join(" · ")}`);
  for (const [i, step] of handoff.steps.entries()) {
    console.log(`   ${i + 1}. ${step.title}${step.sql ? "  [has SQL]" : ""}`);
  }
}

/**
 * Write the draft back to DataHub, clearly labelled. A draft in the catalog is
 * useful — it is where the next person looks — but one that reads like a
 * colleague wrote it would be worse than nothing.
 */
async function writeBack(draft: DraftResult): Promise<string | null> {
  const body =
    `> **This is a draft.** It was assembled from catalog evidence — recorded queries, lineage, ownership and ` +
    `health — with nobody recording. Nothing in it carries the reason the original author would have given. ` +
    `Correct it before treating it as a runbook.\n\n` +
    `**Evidence it was drafted from:** ${draft.basis.join("; ")}.\n\n` +
    handoffToMarkdown(draft.handoff);

  const result = await callDataHubTool("save_document", {
    document_type: "Note",
    title: `Draft runbook: ${draft.handoff.title}`,
    content: body,
    topics: ["onboarding", "runbook", "draft"],
    related_assets: [...new Set(draft.handoff.steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))].slice(0, 10),
  });
  if (result.isError) {
    console.error(`   ⚠️  could not write back: ${result.content.slice(0, 160)}`);
    return null;
  }
  const documentUrn = result.content.match(/urn:li:document[^"'\s,}]*/)?.[0] ?? null;
  return documentUrn;
}

async function main() {
  if (!query && !urn) {
    console.error(
      "usage: npm run draft -- --query=<search> | --urn=<dataset urn>  [--count=N] [--save] [--out=dir] [--json]"
    );
    process.exit(1);
  }

  if (!json) {
    console.log(
      `Drafting from ${isDemoMode() ? "the demo fixture" : "live DataHub"} — reading recorded queries, lineage, ` +
        `ownership and health.`
    );
  }

  const drafts = urn
    ? [await draftRunbook(urn)].filter((d): d is DraftResult => Boolean(d))
    : await draftForQuery(query!, count);

  if (drafts.length === 0) {
    console.log(
      "\nNothing to draft. The catalog holds no recorded queries and no lineage for the matching datasets, " +
        "which is not enough to say anything honest about how to work with them."
    );
    process.exit(0);
  }

  for (const draft of drafts) {
    if (!json) report(draft);

    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, `${draft.handoff.id}.md`), handoffToMarkdown(draft.handoff));
      writeFileSync(path.join(outDir, `${draft.handoff.id}.json`), JSON.stringify(draft.handoff, null, 2));
    }

    if (save) {
      saveHandoff(draft.handoff);
      const documentUrn = await writeBack(draft);
      if (!json) {
        console.log(`   ✓ saved as ${draft.handoff.id}${documentUrn ? ` · written back as ${documentUrn}` : ""}`);
      }
    }
  }

  if (json) {
    console.log(JSON.stringify(drafts.map((d) => ({ handoff: d.handoff, basis: d.basis })), null, 2));
  } else {
    console.log(
      `\n${drafts.length} draft${drafts.length === 1 ? "" : "s"}${save ? " saved" : " (pass --save to keep them)"}. ` +
        `They validate like any other runbook: \`npm run validate\`.`
    );
  }
}

main()
  // The MCP stdio subprocess keeps the event loop alive, so exit explicitly.
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
