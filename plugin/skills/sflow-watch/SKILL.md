---
name: sflow-watch
description: Watch a governed work item for remote lifecycle changes without modifying its branch or state.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--once]"
---
# Watch governed work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Prefer `singularity-flow watch $ARGUMENTS --once --fetch` for one bounded refresh.
2. Start continuous watching only when the user explicitly asks for it and preserve the requested interval.
3. Relay remote phase, approval, publication, and completion changes without inventing progress.
4. Watching is read-only. Do not check out, reset, merge, approve, or repair a branch.

