---
name: catalog-onboarding
description: Onboard a new data-team member, capture a departing member's knowledge as a runbook, or validate an existing onboarding doc against the live DataHub catalog
argument-hint: "[role + domain to onboard | task to capture | document to validate]"
---

Use the Skill tool to invoke the full `datahub-onboarding` skill:

```
Skill tool:
  skill: datahub-skills:datahub-onboarding
```

**User's request:** $ARGUMENTS

If no arguments provided, ask whether the user wants to (1) orient a new team member —
and for their role and domain, (2) capture a departing member's task knowledge as a
runbook — and for the task, or (3) validate an existing runbook or onboarding document
against the live catalog.
