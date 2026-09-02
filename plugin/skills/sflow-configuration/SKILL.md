---
name: sflow-configuration
description: Validate, save, and explicitly publish governed Singularity Flow configuration changes.
disable-model-invocation: true
argument-hint: "validate|save <path>|publish"
---
# Manage governed configuration

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow configuration validate --json` before proposing any write.
2. For save, require the exact reviewed source path. For publish, show the changed governed files, target configuration branch, commit message, and remote state.
3. Require an explicit mutation request, then run only the selected `configuration save` or `configuration publish` operation.
4. Report validation, commit, push, and active-work invalidation effects. Never edit lifecycle snapshots or publish directly to an application branch.

