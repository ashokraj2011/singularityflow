---
name: sflow-initiative-next
description: Show the deterministic next actions for the active multi-repository initiative in GitHub Copilot without changing lifecycle state.
disable-model-invocation: true
argument-hint: "[INIT-ID]"
---
# Show initiative next actions

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow initiative next [INIT-ID] --json`.
2. Present each returned action in order with its exact command and reason.
3. Call out missing output approvals, checklist evidence, stale contracts, incomplete blocking stories, and materialization work.
4. Keep this operation read-only. Do not execute an action unless the contributor explicitly asks.
