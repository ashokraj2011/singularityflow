---
name: sflow-epic-stories
description: List, inspect, and validate the editable Stories produced by an approved Epic Planning package.
disable-model-invocation: true

---

# Review planned Stories

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `singularity-flow epic planning status --json`.
2. Open `artifacts/epic-planning/story-plan.yml` and the generated `artifacts/epic-planning/stories/<PLAN-ID>/story-spec.md` files.
3. Show a compact table with plan ID, title, repository, workflow type, REQ/AC allocation, dependencies, task count, metadata, parent mode, and specification hash.
4. Use `singularity-flow epic stories update`, `split`, or `adopt` for requested terminal edits. Tasks may be supplied with `--tasks-file`; key/value metadata uses repeatable `--metadata KEY=VALUE`.
5. Clearly state that any edit invalidates the former Planning package hash and returns it to UI review.
6. Never invent a Jira key or assignee. Jira keys are returned only during the reviewed publish operation; assignment remains in Jira. An adopted Jira Story keeps its current parent, including no parent.
