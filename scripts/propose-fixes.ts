/**
 * Turn drift into a reviewable correction.
 *
 *   npm run propose                     # write proposals for every stale runbook
 *   npm run propose -- --filter=mrr     # only runbooks whose id matches
 *   npm run propose -- --apply          # accept them into the local runbook store
 *   npm run propose -- --pr             # open a GitHub PR with the corrected runbook
 *
 * The default is deliberately inert: it validates, derives the corrections from
 * the catalog, and writes them to `proposals/` for a person to read. `--apply`
 * and `--pr` are the two ways to say yes, and neither happens on its own. A
 * document whose entire value is that a colleague trusted it does not get
 * rewritten by a cron job without somebody signing off.
 *
 * Everything proposed is traceable: each edit names the catalog evidence behind
 * it, and each finding it *didn't* correct says why it needs a person instead.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectDecayWithState } from "../lib/decay";
import { handoffToMarkdown, listHandoffs, saveHandoff } from "../lib/handoff-store";
import { proposalToMarkdown, proposeFix, type RunbookProposal } from "../lib/remediate";
import { pushHandoffDocument } from "../lib/runbook-sync";

const args = process.argv.slice(2);
const filter = args.find((a) => a.startsWith("--filter="))?.split("=")[1];
const apply = args.includes("--apply");
const openPr = args.includes("--pr");
const json = args.includes("--json");

const PROPOSAL_DIR = path.join(process.cwd(), "proposals");
/** Where runbooks live as reviewable files — what a PR edits. */
const RUNBOOK_DIR = process.env.RUNBOOK_REPO_DIR || path.join(process.cwd(), "examples", "runbooks");

function git(...argv: string[]): string {
  return execFileSync("git", argv, { encoding: "utf8" }).trim();
}

function writeProposal(proposal: RunbookProposal): string[] {
  mkdirSync(PROPOSAL_DIR, { recursive: true });
  const base = path.join(PROPOSAL_DIR, proposal.runbookId);
  const written = [`${base}.md`, `${base}.json`];
  writeFileSync(`${base}.md`, proposalToMarkdown(proposal));
  writeFileSync(`${base}.json`, JSON.stringify(proposal, null, 2));
  if (proposal.diff) {
    writeFileSync(`${base}.diff`, proposal.diff);
    written.push(`${base}.diff`);
  }
  return written.map((f) => path.relative(process.cwd(), f));
}

/**
 * Open a pull request carrying the corrected runbook.
 *
 * The PR is the approval gate: a diff a data engineer reviews the way they
 * review any other change, with the catalog evidence for each edit in the body.
 * Refuses on a dirty tree rather than sweeping unrelated work into the branch.
 */
function openPullRequest(proposal: RunbookProposal): string {
  if (git("status", "--porcelain")) {
    throw new Error("The working tree has uncommitted changes. Commit or stash them before opening a PR.");
  }
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
  } catch {
    throw new Error("`gh` is not authenticated. Run `gh auth login`, or drop --pr and review proposals/ instead.");
  }

  const startedOn = git("rev-parse", "--abbrev-ref", "HEAD");
  const branch = `runbook-fix/${proposal.runbookId}-${proposal.at.slice(0, 10).replace(/-/g, "")}`;
  git("checkout", "-b", branch);
  try {
    mkdirSync(RUNBOOK_DIR, { recursive: true });
    const mdFile = path.join(RUNBOOK_DIR, `${proposal.runbookId}.md`);
    const jsonFile = path.join(RUNBOOK_DIR, `${proposal.runbookId}.json`);
    writeFileSync(mdFile, handoffToMarkdown(proposal.updated));
    writeFileSync(jsonFile, JSON.stringify(proposal.updated, null, 2));

    const bodyFile = path.join(PROPOSAL_DIR, `${proposal.runbookId}.pr.md`);
    writeFileSync(bodyFile, proposalToMarkdown(proposal));

    git("add", mdFile, jsonFile);
    git(
      "commit",
      "-m",
      `Correct the ${proposal.title} runbook against the catalog`,
      "-m",
      proposal.edits.map((e) => `${e.kind}: ${e.from} → ${e.to} (${e.rationale})`).join("\n")
    );
    git("push", "-u", "origin", branch);

    return execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        `Correct the "${proposal.title}" runbook against the catalog`,
        "--body-file",
        bodyFile,
        "--base",
        startedOn,
      ],
      { encoding: "utf8" }
    ).trim();
  } finally {
    git("checkout", startedOn);
  }
}

async function main() {
  const handoffs = listHandoffs().filter((h) => !filter || h.id.includes(filter));
  if (handoffs.length === 0) {
    console.log(`No runbooks${filter ? ` matching "${filter}"` : ""} stored, so nothing to propose.`);
    return;
  }

  const proposals: RunbookProposal[] = [];

  for (const handoff of handoffs) {
    const { report, live } = await detectDecayWithState(handoff);
    if (report.severity === "ok") {
      if (!json) console.log(`✅ ${handoff.title}: nothing has drifted, so there is nothing to correct.`);
      continue;
    }

    const proposal = proposeFix(handoff, report, live);
    proposals.push(proposal);

    if (!json) {
      console.log(
        `\n${report.severity === "broken" ? "🛑" : "⚠️"} ${handoff.title}: ${report.findings.length} finding(s) → ` +
          `${proposal.edits.length} proposed edit(s), ${proposal.unresolved.length} for a person`
      );
      for (const e of proposal.edits) {
        console.log(`    ✎ step ${e.stepIndex + 1} ${e.kind}: ${e.from} → ${e.to} [${e.confidence}]`);
        console.log(`        ${e.rationale}`);
      }
      for (const u of proposal.unresolved) {
        console.log(`    ? step ${u.stepIndex + 1} ${u.kind}: ${u.needsHuman}`);
      }
      const files = writeProposal(proposal);
      console.log(`    wrote ${files.join(", ")}`);
      if (proposal.reviewers.length) console.log(`    reviewers (current owners): ${proposal.reviewers.join(", ")}`);
    } else {
      writeProposal(proposal);
    }

    if (apply && proposal.edits.length) {
      saveHandoff(proposal.updated);
      if (!json) console.log(`    ✓ applied to the runbook store (${proposal.edits.length} edit(s))`);
      // The body of record lives in DataHub, so an accepted correction goes
      // there too — compare-and-set on the content digest, and refused rather
      // than clobbering a document somebody edited in the catalog meanwhile.
      const pushed = await pushHandoffDocument(proposal.updated);
      if (!json) {
        console.log(
          pushed.action === "pushed"
            ? `    ✓ pushed to the DataHub document (${pushed.localDigest})`
            : `    ⚠️  DataHub document not updated (${pushed.status}): ${pushed.detail}`
        );
      }
    }

    if (openPr && proposal.edits.length) {
      try {
        const url = openPullRequest(proposal);
        console.log(`    ✓ pull request opened: ${url}`);
      } catch (err) {
        console.error(`    ⚠️  could not open a PR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (json) {
    console.log(JSON.stringify(proposals, null, 2));
  } else if (proposals.length) {
    console.log(
      `\n${proposals.length} proposal(s) written to ${path.relative(process.cwd(), PROPOSAL_DIR)}/. ` +
        `Review, then re-run with --apply to accept them${existsSync(RUNBOOK_DIR) ? " or --pr to open a pull request" : ""}.`
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
