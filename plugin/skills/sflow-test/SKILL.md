---
name: sflow-test
description: Run this capability's or Story step's tests with the declared commands, in the environment the person picks, and summarise every test case.
disable-model-invocation: true
argument-hint: "[--work-id <ID> --phase <PHASE>] [--command <ID>]... [--environment ENV]"
---
# Run the tests

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.
The commands are the ones the capability selects, else the ones the Story's code step runs; never invent a test command.

1. Run `singularity-flow tests run --json` with the scope, commands and environment in `$ARGUMENTS`. Without `--work-id` it is a local preview for the capability that owns this checkout; add `--work-id <ID> --phase <PHASE>` when the person wants the run to count for that Story step.
2. A command that needs an environment: pick the one named, else the only one allowed, else ask with `ask_user` which of the allowed ones, showing each binding status. For one that is not bound, give the person `singularity-flow env bind <ENV> --stdin` to run in their own terminal from their own secret helper; never ask for, type or pipe a value, and never run `singularity-flow env bind` yourself.
3. Run `singularity-flow tests summary --run <RUN-ID> --json` with the run the result names. Report the totals, each failed case (name, `file:line`), the untagged count and each command's note, and the run's `label` exactly as returned. Say a run counts for a Story step only when `countsForStep` is true; a local preview never does.
4. Do not edit tests or code in this turn. Report failures with their cases, and the next action from the result.
