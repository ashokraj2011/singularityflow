---
name: sflow-run-app
description: Start, check or stop this capability's application with the start command its capability declares, in the environment the person picks.
disable-model-invocation: true
argument-hint: "[start|status|stop] [START-ID] [--environment ENV]"
---
# Run the application

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.
The capability's `application.start` entries say how to start it; never guess a dev command.

1. Run `singularity-flow app plan --json` (add `--capability <ID>` only when the person named one). With no start entry, show the refusal's fix: a reviewed capability proposal adds `application.start`.
2. Pick the start entry named in `$ARGUMENTS`, else the only one, else ask with `ask_user`. Pick the environment named, else the only one listed, else ask which of `environments[].name`, showing each binding `status`. For an environment that is not bound, give the person `singularity-flow env bind <ENV> --stdin` to run in their own terminal, piped from their own secret helper; never ask for, type or pipe a value, and never run `singularity-flow env bind` yourself.
3. To start: run `singularity-flow app start <ID> [--environment <ENV>]` with your terminal tool's background (async) mode so it keeps running, then run `singularity-flow app status --json` until that entry is `ready` or reports its failure, within its `ready.timeoutMs`. Report the URL.
4. To check: `singularity-flow app status --json`. To stop: `singularity-flow app stop <ID>`; it stops only what `singularity-flow app start` recorded. Never kill any other process.
5. Report the entry, environment, URL and state, and the next action (run the tests with `/sf-test`, or stop it).
