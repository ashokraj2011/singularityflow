---
name: sflow-watch
description: Watch a governed work item for remote lifecycle changes without modifying its branch or state.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--once]"
---
# Watch governed work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Prefer `singularity-flow watch $ARGUMENTS --once --fetch` for one bounded refresh.
2. Start continuous watching only when the user explicitly asks for it and preserve the requested interval.
3. Relay remote phase, approval, publication, and completion changes without inventing progress.
4. Watching is read-only. Do not check out, reset, merge, approve, or repair a branch.

