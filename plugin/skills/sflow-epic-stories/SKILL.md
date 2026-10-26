---
name: sflow-epic-stories
description: List, inspect, and validate the editable Stories produced by an approved Epic Planning package.
disable-model-invocation: true

---

# Review planned Stories

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow epic stories list --json` for the plan rows.
2. Run `singularity-flow initiative documents epic-planning --initiative <EPIC-ID> --json` and use only its returned outputs and `repositoryPath` values: the Story plan and the Story specification index, whose `stories[].path` entries resolve against the index's directory. The initiative root is configurable: never construct these paths or search for them.
3. Show a compact table with plan ID, title, repository, workflow type, REQ/AC allocation, dependencies, task count, metadata, parent mode, and specification hash.
4. Use `singularity-flow epic stories update`, `split`, or `adopt` for requested terminal edits. Tasks may be supplied with `--tasks-file`; key/value metadata uses repeatable `--metadata KEY=VALUE`.
5. Clearly state that any edit invalidates the former Planning package hash and returns it to UI review.
6. Never invent a Jira key or assignee. Jira keys are returned only during the reviewed publish operation; assignment remains in Jira. An adopted Jira Story keeps its current parent, including no parent.
