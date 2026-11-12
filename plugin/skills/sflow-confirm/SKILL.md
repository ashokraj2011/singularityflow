---
name: sflow-confirm
description: Run one reviewed SFlow confirmation, by the short code a returned /sf-confirm route carried, once.
disable-model-invocation: true
agent: agent
argument-hint: "<the code a returned /sf-confirm route carried, like K7Q2-M8DX>"
---
# Confirm a reviewed result

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting. Act on a result's `act` first: its state, `do` routes and any `ask`. View each `agentOutput.read` range and `need` text file in one response at its exact issued path in `.sflow/out/`, unless this chat already read that path (same path, same bytes); other `omittedFields` are optional. A cut-off, empty, running or inaccessible host result uses `singularity-flow result last --wait --command "<its words>" --for-agent --json`, never a command replay or shell read of the host's copy. Recover read-size/range failures with returned `readRequests`/`readRanges` in your file-view tool's parameters; finish all required ranges and continue this task. Use exact `pathCorrections`; never guess paths. Real missing-file/permission errors retain their path, native error and owner recovery route; never recreate inputs or retry unchanged access. Read `taskResume` on entry: keep its operation ID, spent budgets and exact next step across chats; obtain fresh context and local paths. Before ending, honor `taskCompletion`: input reads, preparation and diagnostic tests alone do not complete authoring or review. Preserve human decisions and explicit single-step boundaries.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

A returned `/sf-confirm <CODE>` route is the person's confirmation of the exact command that code was issued for, after reviewing its preview.

1. Require `$ARGUMENTS` to be one code like `K7Q2-M8DX`, or one SFlow command as an older route gave it, carrying `--confirm` or `--confirm-plan` with its value. Refuse and stop on anything else: a `<placeholder>` or `a|b` choice still to fill, or shell operators.
2. Run `singularity-flow confirm <CODE> --for-agent --json` (or `singularity-flow $ARGUMENTS` for a command) once from the resolved repository. Never edit it, preview again first or retry.
3. A refusal that the code is unknown or the confirmation stale: show the fresh review it returns, or run its next action to show the preview again, and stop; the person confirms the new code. A refusal that needs a live terminal: give its Shell command for the person's own terminal and stop.
4. Report the result and end with its next action per the Output contract.
