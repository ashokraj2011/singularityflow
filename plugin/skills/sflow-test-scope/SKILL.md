---
name: sflow-test-scope
description: Show or change which tests this Story runs, all configured, changed and affected, or only new and changed, at any step while it is open.
disable-model-invocation: true
agent: agent
argument-hint: "[WORK-ID] [all-configured|changed-and-affected|new-and-changed] [why]"
---
# Change which tests a Story runs

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.
Changing it edits no code, runs no test and leaves every recorded run as it is. A run on the same code that already covers what is asked is not repeated.

1. Run `singularity-flow story test-policy scope [WORK-ID] --json` and report `label` and `meaning`, then every entry of `scopes`. Without a scope in `$ARGUMENTS`, that report is the answer.
2. With one, use its exact ID: `all-configured`, `changed-and-affected` or `new-and-changed` ("only new"). `changeable: false` means it cannot change now; say why from `sealedBy` or the Story's state.
3. A move to fewer tests needs a reason, 10 to 500 characters, and the step's reviewer reads it. Use the person's words from `$ARGUMENTS`; if they gave none, ask with `ask_user`. Say plainly when `new-and-changed` means the Story's existing tests will run only once, at its last step that runs tests, and only those that import a module it changed.
4. Run `singularity-flow story test-policy scope [WORK-ID] --to <SCOPE> [--reason <WHY>] --json` once. Report the new `label`, the recorded `record.id` and what `meaning` says runs next.
