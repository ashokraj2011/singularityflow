---
name: sflow-epic-stories
description: List, inspect, and validate the editable Stories produced by an approved Epic Planning package.
disable-model-invocation: true

---

# Review planned Stories

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic stories list --json` for the plan rows.
2. Open only the plan and Story specification paths the CLI returns (`singularity-flow epic planning status --json` outputs); never assume a folder layout. Resolve both inside this repository; never search outside it.
3. Show a compact table with plan ID, title, repository, workflow type, REQ/AC allocation, dependencies, task count, metadata, parent mode, and specification hash.
4. Use `singularity-flow epic stories update`, `split`, or `adopt` for requested terminal edits. Tasks may be supplied with `--tasks-file`; key/value metadata uses repeatable `--metadata KEY=VALUE`.
5. Clearly state that any edit invalidates the former Planning package hash and returns it to UI review.
6. Never invent a Jira key or assignee. Jira keys are returned only during the reviewed publish operation; assignment remains in Jira. An adopted Jira Story keeps its current parent, including no parent.
