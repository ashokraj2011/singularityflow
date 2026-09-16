---
name: sflow-configuration
description: Inspect, explain, validate, save, and explicitly publish governed Singularity Flow configuration changes.
disable-model-invocation: true
argument-hint: "show|explain [--pointer <JSON-POINTER>]|validate|save <path>|publish"
---
# Manage governed configuration

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. For `show` or `explain`, run the exact requested read-only command and preserve any explicit
   `--pointer`; do not substitute validation or a write.
2. Run `singularity-flow configuration validate --json` before proposing any write.
3. For save, require the exact reviewed source path. For publish, show the changed governed files, target configuration branch, commit message, and remote state.
4. Require an explicit mutation request, then run only the selected `singularity-flow configuration save` or `singularity-flow configuration publish` operation.
5. Report validation, commit, push, and active-work invalidation effects. Never edit lifecycle snapshots or publish directly to an application branch.

Always report the equivalent routes:

- Shell: the exact `singularity-flow configuration ...` command that was run or offered.
- Copilot: `/sf-configuration` with the same explicit operation and operands.
