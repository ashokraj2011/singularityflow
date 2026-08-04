---
name: sflow-home
description: Open the Singularity Flow cockpit for the current repository and show progress, real identity, governed agent, assignment, blockers, and safe next actions.
disable-model-invocation: true

---
# Singularity Flow cockpit

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

Run `singularity-flow cockpit`. Reproduce the current phase, progress, real Git identity, prompt-only governed agent, assignment, and next actions in the visible response. Do not mutate lifecycle state. If setup is incomplete, follow with `singularity-flow doctor` and explain only the failed or warning checks.
