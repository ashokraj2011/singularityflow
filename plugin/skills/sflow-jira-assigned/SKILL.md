---
name: sflow-jira-assigned
description: List incomplete Jira Stories assigned to the authenticated Jira user, optionally filtered to a project, from Copilot CLI. Use only on explicit request.
disable-model-invocation: true
agent: agent
argument-hint: "[--project KEY] [--type Story] [--limit 25]"

---

# My assigned Jira Stories

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Use Singularity Flow's direct Jira REST client. Do not use Jira MCP tools.

1. Run (it checks the connection itself; relay a connection or credential refusal):

   `singularity-flow jira assigned [--project <KEY>] [--type <ISSUE-TYPE>] [--limit <N>] --json`

2. Present a compact table containing Jira key, summary, status, active or future sprint, priority, parent, and updated time.
3. State that the default query is:
   - assigned to the authenticated Jira user;
   - issue type `Story`;
   - status category not Done.
4. When there are no results, report that clearly. Do not silently broaden the project, issue type, assignee, or status filter.

This skill is read-only. Never request or display the user's Jira token or password. Use `/sf-jira-update` only when the user explicitly asks to change one Story.
