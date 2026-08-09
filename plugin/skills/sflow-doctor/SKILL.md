---
name: sflow-doctor
description: Check whether this repository is healthy, and what to fix.
argument-hint: "[work ID]"

---
# Diagnose setup and recovery

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

Run `singularity-flow init --check --json` first, then run
`singularity-flow doctor $ARGUMENTS`. Report each failure with its exact safe
fix and summarize warnings separately. The initialization check covers the
workflow, portfolio, templates, prompts, and governed-agent files installed on
the current branch. Both commands are read-only. Recommend `/sf-init` when
assets are missing. Do not reset, stash, switch branches, or edit
configuration unless the user explicitly asks you to apply a fix.

When a failure is not explained by the current state, read what actually happened with `/sf-logs` — `singularity-flow logs --level warn` shows recent failures and refused tool calls, including the reason a hook blocked a command. Diagnose from the log rather than retrying blindly.
