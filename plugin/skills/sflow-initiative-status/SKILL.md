---
name: sflow-initiative-status
description: Display initiative phase progress, evidence readiness, child-story milestones, and current gate state in GitHub Copilot.
argument-hint: "[INIT-ID]"
---
# Show initiative status

1. Run `singularity-flow initiative status [INIT-ID] --json`.
2. Render the ordered phase flow using approved, active, awaiting-approval, stale, and not-started states.
3. Run `singularity-flow initiative report [INIT-ID] --format json` and summarize blocking stories, stale contracts, evidence assurance, self-approvals, elapsed time, models, tokens, and cost availability.
4. End with the first result from `singularity-flow initiative next [INIT-ID] --json`.

Keep this operation read-only and preserve the `configured-local` identity-assurance disclosure.
