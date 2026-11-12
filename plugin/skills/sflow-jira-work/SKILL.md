---
name: sflow-jira-work
description: List Jira stories assigned to the authenticated user or retrieve a specific Jira issue using Singularity Flow's direct Jira REST client. Use only on explicit request.
disable-model-invocation: true
agent: agent
argument-hint: "[WORK-ID] [--project KEY] [--type Story]"

---
# Jira work through Singularity Flow

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

No MCP server or IDE Jira plugin is used.

- Check the connection with `/sf-jira-status`.
- List assigned work with `/sf-jira-assigned` (`singularity-flow jira assigned`; `singularity-flow jira list` remains an alias).
- Browse active and future sprint Stories without backlog with `/sf-jira-board`.
- Make a separately confirmed status, assignee, priority, sprint, or comment change with `/sf-jira-update`.
- Retrieve a specific item with `singularity-flow jira pull <WORK-ID>` (`show` remains an alias).
- Discover custom field IDs with `singularity-flow jira fields --query acceptance`, `--query story points`, or `--query sprint`.
- Start selected Jira work with `/sf-start <WORK-ID> --jira`, which collects the remaining choices (Shell: `singularity-flow start <WORK-ID> --jira`).

Jira Cloud access requires `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`; Jira Data Center requires `JIRA_BASE_URL`, `JIRA_DEPLOYMENT=data-center`, and `JIRA_PAT`. When the connection fails, offer `/sf-jira-doctor`. Never request the user's Atlassian password, display the token, or store credentials in Git.
