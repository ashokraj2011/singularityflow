---
name: sflow-refresh-configuration
description: Preview and explicitly apply a versioned workspace configuration refresh across registered repositories.
disable-model-invocation: true
argument-hint: "[WORKSPACE-ID] [--repository REPOSITORY-ID] [--resolve PATH=local|bundled|merge]"
---

# Refresh approved workspace configuration

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Preserve the CLI's exact plan, conflicts, branch effects, failures, and retry instructions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow workspace refresh-configuration [WORKSPACE-ID] [--repository REPOSITORY-ID] --dry-run --json` using only the user's explicit scope. Do not infer a repository from chat history.
2. Show each repository's current authority, candidate changes, protected conflicts, exact plan ID, and proposed `sflow/config` and state-branch effects. A preserved conflict is not consent to overwrite it.
3. If a conflict needs resolution, ask the contributor to choose each exact `--resolve PATH=local|bundled|merge` value, then preview again with those choices. Do not select `--accept-bundled-conflicts` on their behalf.
4. Ask for explicit confirmation of the returned plan. Only then run the same scoped command with the same resolution choices and `--confirm-plan <EXACT-PLAN-ID> --json`. If the plan is stale, stop and preview again; never reuse the old confirmation.
5. Report configuration and state projection results separately. If a protected remote retains a review branch, report that exact branch and the normal review/merge step. Retry only as the CLI directs; do not force-push or edit active Story snapshots.

Shell: `singularity-flow workspace refresh-configuration`. Copilot: `/sf-refresh-configuration`.
