---
name: sflow-jira-update
description: Safely update one Jira Story's status, assignee, priority, sprint, or comments through Singularity Flow with exact Story-key confirmation. Use only on explicit request.
disable-model-invocation: true
argument-hint: "<STORY-KEY>"

---

# Update one Jira Story

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

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
