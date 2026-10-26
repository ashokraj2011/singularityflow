---
name: sflow-doctor
description: Check whether this repository is healthy, and what to fix.
disable-model-invocation: true
argument-hint: "[work ID] [--offline] [--performance]"

---
# Diagnose setup and recovery

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow workspace current --json`. When it returns a repository, use only its exact
   `repositoryPath` as cwd; when it returns none, use the opened Git root (the repository this chat was
   opened in) as cwd. Never search for one.
2. With a repository, run `singularity-flow init --check --json`, then
   `singularity-flow doctor $ARGUMENTS`. Report each failure with its exact safe fix and summarize
   warnings separately. The initialization check covers workflow, portfolio, templates, prompts,
   and governed-agent files on the current branch. Recommend `/sf-init` when assets are missing.
3. Only without either, run `singularity-flow workspace doctor --json`. It is machine-local and
   offline by default. Add `--network` only after the contributor explicitly chooses to contact the
   remotes named by unfinished bootstrap sessions. Relay proxy and certificate configuration source
   names, never their values; never request credentials or recommend disabling TLS.

All checks above are read-only. Do not reset, stash, switch branches, or edit configuration unless
the user explicitly asks you to apply a fix.

When the user asks about monorepo or Git slowness, pass `--performance --json`.
Relay the measured total/scoped file counts, warm status/fingerprint times, clone
mode, and recommendations. The benchmark is read-only: never enable FSMonitor,
untracked cache, sparse checkout, or a partial-clone fallback on the user's
behalf merely because the report recommends evaluating it.

When a failure is not explained by the current state, read what actually happened with `/sf-logs` — `singularity-flow logs --level warn` shows recent failures and refused tool calls, including the reason a hook blocked a command. Diagnose from the log rather than retrying blindly.
