---
name: sflow-initiative-status
description: Display initiative phase progress, evidence readiness, child-story milestones, and current gate state in GitHub Copilot.
disable-model-invocation: true
agent: agent
argument-hint: "[INIT-ID]"
---
# Show initiative status

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow initiative status [INIT-ID] --json`.
2. Render the ordered phase flow using approved, active, awaiting-approval, stale, and not-started states.
3. Run `singularity-flow initiative report [INIT-ID] --format json` and summarize blocking stories, stale contracts, evidence assurance, self-approvals, elapsed time, models, tokens, and cost availability.
4. End with the first result from `singularity-flow initiative next [INIT-ID] --for-agent --json`.

Keep this operation read-only and preserve the `configured-local` identity-assurance disclosure.
