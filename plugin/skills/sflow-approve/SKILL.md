---
name: sflow-approve
description: Interactively select a persona and approve a submitted Singularity Flow phase from any terminal, recording identity, persona, self-approval warning, hashes, commit, and push.
argument-hint: "[WORK-ID] [--fetch]"
disable-model-invocation: true
---
# Approve the submitted phase

If any command exits with `Out of sequence`, stop immediately, relay the actionable error, and use only `singularity-flow nextsteps` to confirm the valid next action. Never bypass sequence enforcement by editing managed state.

Anyone may choose any persona, but the chosen persona must be configured to approve the phase.

1. Run `singularity-flow approve <WORK-ID> --fetch` in an interactive terminal; omit the ID only when already on its branch.
2. Let the reviewer choose a persona, then show the phase, artifacts, hashes, checks, token usage, prior decisions, and whether this identity generated the phase.
3. Require explicit phase-name confirmation. Self-approval is allowed but must remain visibly warned and must never be described as independent review.
4. The CLI commits and pushes the decision and advances only after the distinct-identity threshold is met.
5. Report the decision commit, persona, self-approval status, remaining approvals, and next phase. Do not merge, deploy, or modify Jira.
