# Upstream contributions

Two upstream contributions came out of building instaboard. All of them are filed.

| What | Where | Status |
| --- | --- | --- |
| `datahub-onboarding` skill | [datahub-skills#79](https://github.com/datahub-project/datahub-skills/pull/79) | open |
| ↳ follow-up commit: validation write-back and correction steps | [same PR](https://github.com/datahub-project/datahub-skills/pull/79#issuecomment-5159658074) | pushed |
| No MCP tool returns usage statistics | [mcp-server-datahub#171](https://github.com/acryldata/mcp-server-datahub/issues/171) | open |
| Incidents are unreadable over MCP | [mcp-server-datahub#172](https://github.com/acryldata/mcp-server-datahub/issues/172) | open |
| `anyOf` union schemas get 422'd by providers | [mcp-server-datahub#173](https://github.com/acryldata/mcp-server-datahub/issues/173) | open |
| Datapack drops Cloud-only aspects on OSS | [datahub#18815](https://github.com/datahub-project/datahub/issues/18815) | open |
| `deleteAssertion` rejects CUSTOM assertions | [datahub#18817](https://github.com/datahub-project/datahub/issues/18817) | open |
| `datapack --help` crash still on 1.6.0.17 | [comment on datahub#18497](https://github.com/datahub-project/datahub/issues/18497#issuecomment-5159253562) | existing issue |

The sections below record how each was put together, and stay here so the work is
reproducible rather than just linked.

---

## 1. The `datahub-onboarding` skill PR

### Fork and branch

```bash
gh repo fork datahub-project/datahub-skills --clone
cd datahub-skills
git checkout -b feat/datahub-onboarding-skill
```

### Copy the files into place

| From (this directory) | To (registry repo) |
| --- | --- |
| `skills/datahub-onboarding/SKILL.md` | `skills/datahub-onboarding/SKILL.md` |
| `skills/datahub-onboarding/README.md` | `skills/datahub-onboarding/README.md` |
| `skills/datahub-onboarding/evaluations/*.json` | `skills/datahub-onboarding/evaluations/` |
| `commands/catalog-onboarding.md` | `commands/catalog-onboarding.md` |

```bash
cp -r <instaboard>/submission/oss/skills/datahub-onboarding skills/
cp <instaboard>/submission/oss/commands/catalog-onboarding.md commands/
```

### Apply the registry edits

A new skill has to be registered in the router, or it will never be reached.
`registry-edits/router-and-readme.diff` holds both edits, taken against `main`:

- **`skills/using-datahub/SKILL.md`** gains three rows in the routing table, covering
  onboarding, knowledge capture and runbook validation, plus an "Onboarding vs. Search"
  disambiguation block. Skill count goes from 5 to 6.
- **`README.md`** gains `/catalog-onboarding` in the catalog-interaction command table, and
  `datahub-onboarding/` in the repo tree and the Contributing file map.

```bash
git apply <instaboard>/submission/oss/registry-edits/router-and-readme.diff
```

If it doesn't apply cleanly because `main` has moved, make the same edits by hand. They are
small, and the diff reads as a checklist.

### Pre-commit

The repo runs `prettier` (markdown) and `markdownlint-cli2` in CI via `.github/workflows/lint.yml`.

```bash
pip install pre-commit && pre-commit install
pre-commit run --all-files
```

All files in this directory were already formatted with `prettier@3` and pass
`markdownlint-cli2@0.21.0` against the repo's `.markdownlint-cli2.yaml`. Run it anyway in
case the pinned versions have moved.

### Do NOT touch

- `.claude-plugin/plugin.json`
- `CHANGELOG.md`, `.release-please-manifest.json`
- Any version files

Release Please owns versioning; PRs that edit those get bounced (see `CONTRIBUTING.md`).

### Commit and open the PR

PR titles are enforced by the `Lint PR Title` check and must be conventional-commit format:

```bash
git add skills/datahub-onboarding commands/catalog-onboarding.md skills/using-datahub/SKILL.md README.md
git commit -m "feat: add datahub-onboarding skill"
git push -u origin feat/datahub-onboarding-skill
gh pr create --title "feat: add datahub-onboarding skill" --body-file <the body below>
```

### Suggested PR body

````markdown
## What

Adds a `datahub-onboarding` skill, its `/catalog-onboarding` command wrapper, and two
evaluation cases. It covers the two knowledge-transfer moments every data team hits:

- **Someone joins.** Orient them in the catalog: work out which of the same-named copies of
  a table is canonical (certification markers, ownership coverage, platform usage tags,
  lineage position), never recommend a deprecated dataset without naming its replacement,
  surface the real owners *and* the escalation contact from `structuredProperties`, quote
  the glossary's metric definitions, and cite real recorded queries, saying "no recorded
  queries" rather than inventing SQL. Optionally assemble that into a role/domain "week one"
  path and `save_document` it back to the catalog.
- **Someone leaves.** Capture their task knowledge as a runbook where each step carries a
  dataset URN, an action and the *why*. Enrich every step from the catalog with owners,
  schema, recorded SQL and one-hop lineage, then save it back linked to the datasets it
  touches.

Because captured knowledge rots, the skill enforces a staleness rule: on every read-back of
a runbook or onboarding doc, re-verify its claims against the live catalog with
deterministic checks (referenced columns still exist, dataset not deprecated since, `health`
not failing, named owners still owners) and warn before anyone follows a stale step.

## Changes

- `skills/datahub-onboarding/SKILL.md`, the skill itself
- `skills/datahub-onboarding/README.md`, overview and usage
- `skills/datahub-onboarding/evaluations/*.json`, two evaluation cases covering orientation
  and stale-runbook validation
- `commands/catalog-onboarding.md`, the slash-command wrapper
- `skills/using-datahub/SKILL.md`, routing rows plus an Onboarding-vs-Search disambiguation
  block, skill count 5 → 6
- `README.md`, command table, repo tree and Contributing file map

## Notes on tool surface

The skill is written against what `mcp-server-datahub` 0.6.0 actually exposes, which is
worth flagging because it shaped two steps:

- **There is no usage-statistics tool**, and `get_entities` doesn't inline query counts. So
  Step 2 ranks candidates on certification markers, governance weight, platform-assigned
  usage tags and lineage position, and points at
  `datahub get -a datasetUsageStatistics` for raw numbers. Filed separately as an issue.
- **There is no health tool.** `health` and `deprecation` arrive inline on `get_entities`,
  so Step 3 reads them there. The skill calls this out explicitly under Common Mistakes,
  because an agent that goes looking for a health tool, doesn't find one, and concludes
  "no health data" has just declared a broken table healthy.

## Provenance

Extracted and generalised from [instaboard](https://github.com/mcrowley19/Instaboard), a
DataHub onboarding and knowledge-handoff agent built for the DataHub Agent Hackathon. The
workflow was validated there against two 20-question onboarding benchmarks scored
deterministically against catalog facts. One benchmark runs on a purpose-built catalog and
the other on DataHub's own `showcase-ecommerce` datapack, alongside a decay drill that makes
real breaking changes to that datapack and checks the staleness rules catch them. This
skill distils the parts that proved out, with no dependency on the app.

Ran `pre-commit run --all-files` clean. No changes to `plugin.json`, `CHANGELOG.md`, or
version files.
````

---

## 1a. The follow-up commit on the same PR

Steps 9 and 10 were written after the skill went up, once the corresponding parts of
instaboard had been built and proved out end to end against a live catalog
(`npm run prove`, 29/29 checks). They close the loop the original skill only opened: it
detected staleness and warned about it, but left the finding in the chat and the fix to
whoever read it.

What the follow-up adds:

- **Step 8 gains claim-level pinning.** Each claim a document makes records the aspect it
  depends on and a content fingerprint of that aspect's facts, so a verdict is reproducible
  by anyone with the document and a catalog connection. Report "18 of 19 claims still hold",
  not "stale".
- **Step 9, write the staleness back as state.** `StaleRunbook` tag, runbook status and the
  specific breaking change as structured properties, an assertion that fails while the
  runbook is stale, and an incident on any dataset where a step would now fail — assigned to
  whoever owns that dataset today. Includes the two rules that only show up in practice:
  write the clean result too, and discount your own writes on the next pass or the tool
  flags itself forever.
- **Step 10, propose the correction.** A table of what the catalog can and cannot support a
  fix for, presented as a diff for human approval. Including the pronoun rule: replacing a
  departed owner's name without repointing the pronouns that referred to them produces a new
  false statement about a real person.
- **Boundary and Red Flags updated.** The skill now writes metadata in exactly one situation
  — recording the result of validating a document it is responsible for — and says so, with
  general enrichment and quality management still routed to `/datahub-enrich` and
  `/datahub-quality`.
- **A third evaluation**, `evaluations/runbook-drift-writeback.json`, covering the
  write-back and correction path, including the negative cases: no auto-apply, no guessed
  rename when two candidates are comparable, no runbook edit in response to a health
  problem, and no counting your own incident as fresh drift.

Pushed as `d103f41` on `feat/datahub-onboarding-skill`, with a
[comment](https://github.com/datahub-project/datahub-skills/pull/79#issuecomment-5159658074)
summarising it, since the original PR description does not mention Steps 9 and 10. How it
was applied, for anyone reproducing it:

```bash
gh repo fork datahub-project/datahub-skills --clone   # if not already cloned
cd datahub-skills
git fetch origin && git checkout feat/datahub-onboarding-skill
cp -r <instaboard>/submission/oss/skills/datahub-onboarding/. skills/datahub-onboarding/
npx prettier@3 --write "skills/datahub-onboarding/**/*.{md,json}"
npx markdownlint-cli2@0.21.0 "skills/datahub-onboarding/**/*.md"   # 0 errors
git add skills/datahub-onboarding
git commit -m "feat: add validation write-back and correction steps to datahub-onboarding"
git push
```

`prettier` reflowed two lines of `SKILL.md`; the copy in this repo was updated to match, so
the two stay byte-identical.

---

## 2. The friction reports

Four write-ups with reproduction steps are in `issues/`. Each is a complete issue body;
file with `gh issue create -R <repo> --title "<first heading>" --body-file <file>`.

| File | Repo | Summary |
| --- | --- | --- |
| `01-no-usage-statistics-tool.md` | `acryldata/mcp-server-datahub` | No MCP tool returns dataset usage stats and `get_entities` doesn't inline them, leaving an agent no way to rank lookalike tables by real query volume |
| `02-incidents-unreadable.md` | `acryldata/mcp-server-datahub` | `get_entities` on an incident URN errors; the entity's health reports `causes: ["ACTIVE_INCIDENTS"]` instead of URNs, unlike the assertions branch of the same field |
| `03-anyof-union-schemas-rejected-by-providers.md` | `acryldata/mcp-server-datahub` | Multi-type `anyOf` unions in two tool schemas make OpenAI-compatible providers reject the whole tool list with a 422 |
| `04-showcase-datapack-drops-cloud-only-aspects.md` | `datahub-project/datahub` | `datapack load showcase-ecommerce` quietly drops 248 MCPs on OSS, every usage and assertion aspect among them, while still reporting success |
| `05-deleteassertion-rejects-custom-assertions.md` | `datahub-project/datahub` | `deleteAssertion` errors with "Unsupported Assertion Type CUSTOM" on assertions `upsertCustomAssertion` created two calls earlier; only the CLI can remove them — filed as [#18817](https://github.com/datahub-project/datahub/issues/18817) |

Checked against the open issue lists on both repos before writing; none of these is a
duplicate. The incident write-tool requests (#136, #143, #145, #153) are all about
*writing* incidents. `02` covers not being able to *read* one back, and says so.

One more thing we hit is **already filed**: `datahub datapack --help` crashes with
`FileNotFoundError: .../resources/DATAPACK_AGENT_CONTEXT.md`, reported as
[datahub#18497](https://github.com/datahub-project/datahub/issues/18497) against
1.6.0.15. It still reproduces on **1.6.0.17**, so the useful contribution there is a
confirming comment on the existing issue rather than a new one.
