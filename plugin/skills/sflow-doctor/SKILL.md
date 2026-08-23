---
name: sflow-doctor
description: Check whether this repository is healthy, and what to fix.
argument-hint: "[work ID] [--offline] [--performance]"

---
# Diagnose setup and recovery

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

Run `singularity-flow init --check --json` first, then run
`singularity-flow doctor $ARGUMENTS`. Report each failure with its exact safe
fix and summarize warnings separately. The initialization check covers the
workflow, portfolio, templates, prompts, and governed-agent files installed on
the current branch. Both commands are read-only. Recommend `/sf-init` when
assets are missing. Do not reset, stash, switch branches, or edit
configuration unless the user explicitly asks you to apply a fix.

When no repository or workspace exists, run `singularity-flow workspace doctor --json` instead.
It is machine-local and offline by default. Add `--network` only after the contributor explicitly
chooses to contact the remotes named by unfinished bootstrap sessions. Relay proxy and certificate
configuration source names, never their values; never request credentials or recommend disabling TLS.

When the user asks about monorepo or Git slowness, pass `--performance --json`.
Relay the measured total/scoped file counts, warm status/fingerprint times, clone
mode, and recommendations. The benchmark is read-only: never enable FSMonitor,
untracked cache, sparse checkout, or a partial-clone fallback on the user's
behalf merely because the report recommends evaluating it.

When a failure is not explained by the current state, read what actually happened with `/sf-logs` — `singularity-flow logs --level warn` shows recent failures and refused tool calls, including the reason a hook blocked a command. Diagnose from the log rather than retrying blindly.
