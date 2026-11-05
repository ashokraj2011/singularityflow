---
name: sflow-epic-merge-plan
description: Show the dependency-safe merge sequence for finalized Epic Stories and the readiness of the Epic branch.
disable-model-invocation: true
agent: agent

---

# Show the Epic merge plan

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow epic merge-plan --epic <EPIC-KEY> --json`.
2. Display Story order, repository, blocking flag, dependencies, current state, and the next merge candidate.
3. Clearly separate unreachable, blocked, and ready Stories.
4. Report whether every blocking Story has merged and whether the Epic branch is ready.
5. This is read-only; do not merge, rebase, or push.
6. When the Epic branch is ready, offer the read-only preview `singularity-flow epic pr --epic <EPIC-KEY>` (nothing opens without `--create` and the person's confirmation) and `/sf-epic-next` for the next governed step.
