---
name: sflow-jira-update
description: Safely update one Jira Story's status, assignee, priority, sprint, or comments through Singularity Flow with exact Story-key confirmation. Use only on explicit request.
disable-model-invocation: true
agent: agent
argument-hint: "<STORY-KEY>"

---

# Update one Jira Story

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

This skill changes external Jira state. Never run it implicitly or as part of a read-only Jira request.

## Safety boundary

- Never request or display an API token, PAT, password, or authorization header.
- Never infer the Story, transition, assignee, priority, sprint, or comment.
- Make only the operation explicitly requested by the user.
- Read the Story immediately before the update with `singularity-flow jira pull <STORY-KEY> --json`.
- Show the exact before value, requested after value, and Jira key.
- Ask the user to confirm the exact Jira key. The CLI must receive `--confirm <STORY-KEY>`; do not bypass or weaken this check.
- After the update, read and display the returned Story state.
- If Jira rejects a transition because it requires additional screen fields, stop and tell the user to complete that transition in Jira.

## Supported updates

Status:

1. Run `singularity-flow jira transitions <STORY-KEY> --json`.
2. Let the user select an exact transition or target status.
3. Run:

   `singularity-flow jira transition <STORY-KEY> --to <STATUS-OR-TRANSITION-ID> --confirm <STORY-KEY> --expected-updated-at <CURRENT-UPDATED-AT> --json`

Assignee:

`singularity-flow jira assign <STORY-KEY> --to me|unassigned|<ACCOUNT-ID> --confirm <STORY-KEY> --json`

Priority:

`singularity-flow jira priority <STORY-KEY> --to <NAME-OR-ID> --confirm <STORY-KEY> --json`

Sprint:

1. Use `/sf-jira-board` or `singularity-flow jira board <BOARD-ID> --state active,future --json` to show valid sprint IDs.
2. Run:

   `singularity-flow jira sprint <STORY-KEY> --to <SPRINT-ID> --confirm <STORY-KEY> --json`

Comment:

`singularity-flow jira comment <STORY-KEY> --text <TEXT> --confirm <STORY-KEY> --json`

Perform one update at a time. If the user requests several changes, re-read the Story and confirm the Jira key before each external mutation so partial completion remains visible and recoverable.
