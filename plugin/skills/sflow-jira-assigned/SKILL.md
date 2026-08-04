---
name: sflow-jira-assigned
description: List incomplete Jira Stories assigned to the authenticated Jira user, optionally filtered to a project, from Copilot CLI. Use only on explicit request.
disable-model-invocation: true
argument-hint: "[--project KEY] [--type Story] [--limit 25]"

---

# My assigned Jira Stories

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

Use Singularity Flow's direct Jira REST client. Do not use Jira MCP tools.

1. If the connection has not been checked in this session, run `singularity-flow jira status --json`.
2. Run:

   `singularity-flow jira assigned [--project <KEY>] [--type <ISSUE-TYPE>] [--limit <N>] --json`

3. Present a compact table containing Jira key, summary, status, active or future sprint, priority, parent, and updated time.
4. State that the default query is:
   - assigned to the authenticated Jira user;
   - issue type `Story`;
   - status category not Done.
5. When there are no results, report that clearly. Do not silently broaden the project, issue type, assignee, or status filter.

This skill is read-only. Never request or display the user's Jira token or password. Use `/sflow-jira-update` only when the user explicitly asks to change one Story.
