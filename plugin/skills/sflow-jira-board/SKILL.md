---
name: sflow-jira-board
description: List Jira Software boards and show all Stories in active or future sprints while explicitly excluding the backlog. Use only on explicit request.
disable-model-invocation: true
agent: agent
argument-hint: "[BOARD-ID] [--project KEY] [--state active,future]"

---

# Jira board Stories without backlog

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting. Where the steps say ask_user, use your host's question tool: ask_user in the Copilot CLI, vscode_askQuestions in VS Code; it is unavailable only when neither exists.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Use Singularity Flow's direct Jira Software REST client. Do not use Jira MCP tools and do not construct a backlog query.

1. If no board ID was supplied, run (it checks the connection itself):

   `singularity-flow jira boards [--project <KEY>] --json`

2. If exactly one board matches, use it. If multiple boards match, use `ask_user` to let the user select the exact board. Never infer a board from a similar name.
3. Run:

   `singularity-flow jira board <BOARD-ID> --state active,future --type Story --json`

4. Group the result by sprint and show sprint name/state, Story key, summary, status, assignee, and priority.
5. Always say `Backlog excluded`. The command enumerates active and future sprints and reads their issues; it does not call the Jira backlog endpoint.
6. Keep the user-supplied sprint states if they explicitly request `active`, `future`, or `closed`. Do not introduce `closed` by default.

This skill is read-only. Never request or display a Jira token, PAT, password, or authorization header.
