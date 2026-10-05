---
name: sflow-epic-stories
description: List, inspect, and validate the editable Stories produced by an approved Epic Planning package.
disable-model-invocation: true

---

# Review planned Stories

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic planning status --json`.
2. Under the active Epic directory, open `singularity/initiatives/<EPIC-ID>/artifacts/epic-planning/story-plan.yml` and the generated `singularity/initiatives/<EPIC-ID>/artifacts/epic-planning/stories/<PLAN-ID>/story-spec.md` files. Resolve both inside this repository; never search outside it.
3. Show a compact table with plan ID, title, repository, workflow type, REQ/AC allocation, dependencies, task count, metadata, parent mode, and specification hash.
4. Use `singularity-flow epic stories update`, `split`, or `adopt` for requested terminal edits. Tasks may be supplied with `--tasks-file`; key/value metadata uses repeatable `--metadata KEY=VALUE`.
5. Clearly state that any edit invalidates the former Planning package hash and returns it to UI review.
6. Never invent a Jira key or assignee. Jira keys are returned only during the reviewed publish operation; assignment remains in Jira. An adopted Jira Story keeps its current parent, including no parent.
