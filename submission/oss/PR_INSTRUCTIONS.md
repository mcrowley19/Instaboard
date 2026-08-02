# Submitting `datahub-onboarding` to datahub-project/datahub-skills

Steps to turn the files in this directory into an upstream PR.

## 1. Fork and branch

```bash
gh repo fork datahub-project/datahub-skills --clone
cd datahub-skills
git checkout -b feat/datahub-onboarding-skill
```

## 2. Copy the files into place

| From (this directory) | To (registry repo) |
|---|---|
| `skills/datahub-onboarding/SKILL.md` | `skills/datahub-onboarding/SKILL.md` |
| `skills/datahub-onboarding/README.md` | `skills/datahub-onboarding/README.md` |
| `skills/datahub-onboarding/evaluations/new-hire-orientation.json` | `skills/datahub-onboarding/evaluations/new-hire-orientation.json` |
| `skills/datahub-onboarding/evaluations/stale-runbook-validation.json` | `skills/datahub-onboarding/evaluations/stale-runbook-validation.json` |
| `commands/catalog-onboarding.md` | `commands/catalog-onboarding.md` |

```bash
cp -r /Users/michael/hackathon-builds/Instaboard/submission/oss/skills/datahub-onboarding skills/
cp /Users/michael/hackathon-builds/Instaboard/submission/oss/commands/catalog-onboarding.md commands/
```

Before committing, skim a sibling skill (e.g. `skills/catalog-lineage/SKILL.md`) and
verify two things against the live repo, since these files were drafted without it:

- The sibling skill names referenced in our `## Not This Skill` table and description
  (`/catalog-lineage`, `/catalog-search`) match the registry's actual skill/command names.
  Adjust if they differ.
- The `min-cli-version` and `allowed-tools` values match what current skills in the repo
  use.

## 3. Register the skill in `skills/using-datahub/SKILL.md`

The router skill must know about the new one. Two edits (we don't have that file's exact
contents, so match its existing formatting):

1. **Routing table:** add a row for `datahub-onboarding` alongside the existing skills,
   in the same table format the file already uses. Suggested cell text:
   - *When to use:* onboarding a new data-team member, building a week-one learning path,
     capturing a departing member's knowledge as a runbook, or validating a saved
     runbook/onboarding doc against the live catalog.
   - *Skill:* `datahub-onboarding` (command `/catalog-onboarding`).
2. **Count:** the file says something like "5 DataHub catalog interaction skills" — bump
   it to **6**.

## 4. Pre-commit

The repo uses pre-commit hooks; run them before pushing:

```bash
pip install pre-commit && pre-commit install
pre-commit run --all-files
```

Fix anything it flags (typically trailing whitespace, EOF newlines, YAML/JSON formatting)
and re-run until clean.

## 5. Do NOT touch

- `plugin.json`
- `CHANGELOG` / `CHANGELOG.md`
- Any version files

Maintainers handle versioning and release metadata; PRs that modify them get bounced.

## 6. Commit and open the PR

PR title must be conventional-commit format, exactly:

```
feat: add datahub-onboarding skill
```

```bash
git add skills/datahub-onboarding commands/catalog-onboarding.md skills/using-datahub/SKILL.md
git commit -m "feat: add datahub-onboarding skill"
git push -u origin feat/datahub-onboarding-skill
gh pr create --title "feat: add datahub-onboarding skill" --body-file <path to body below>
```

## Suggested PR description body

```markdown
## What

Adds a new user-invocable skill, `datahub-onboarding`, plus its `/catalog-onboarding`
slash-command wrapper and two evaluation cases.

The skill covers the two knowledge-transfer moments every data team hits:

- **Someone joins:** orient them in the catalog — rank datasets by real 30-day usage
  (`get_usage_stats`), never recommend a deprecated dataset without flagging it and naming
  its replacement (`get_dataset_health`), surface actual owners, glossary metric
  definitions, and real recorded queries (`get_dataset_queries`) instead of invented SQL.
  Optionally assemble this into a role/domain "week one" learning path and save it back to
  the catalog with `save_document`.
- **Someone leaves:** capture their task knowledge as a runbook — dataset URN, action, and
  the *why* for each step — enrich each step from the catalog (owners, schema, saved SQL,
  lineage), and save it back linked to the datasets it touches.

Because captured knowledge rots, the skill also enforces a staleness rule: on every
read-back of a runbook or onboarding doc, it re-verifies the doc's claims against the live
catalog with deterministic checks (referenced columns still exist, dataset not deprecated
since, assertions passing, named owners still owners) and warns before anyone follows a
stale step.

## Changes

- `skills/datahub-onboarding/SKILL.md` — the skill
- `skills/datahub-onboarding/README.md` — overview and usage
- `skills/datahub-onboarding/evaluations/*.json` — two evaluation cases (orientation,
  stale-runbook validation)
- `commands/catalog-onboarding.md` — slash-command wrapper
- `skills/using-datahub/SKILL.md` — routing table entry; skill count 5 → 6

## Provenance

This skill was extracted and generalized from **instaboard**
(https://github.com/mcrowley19/Instaboard), a DataHub onboarding/knowledge-handoff agent
built for the DataHub Agent Hackathon. The workflow was validated there against a
20-question onboarding benchmark scored deterministically against catalog facts; the
skill distills the parts that proved out (usage-ranked recommendations, deprecation
guardrails, real-SQL-only, catalog write-back, deterministic staleness checks) into
registry form, with no dependency on the app.

Ran `pre-commit run --all-files` clean. No changes to `plugin.json`, `CHANGELOG`, or
version files.
```
