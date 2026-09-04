---
name: sflow-capability-depend
description: Propose an exact published-contract dependency discovered from a convenient reference.
disable-model-invocation: true
argument-hint: "<TARGET-CAPABILITY>@<REFERENCE>"
---
# Depend on a capability contract

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Relay exact contract resolution or refusal and the proposal identity; never activate it.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require the target capability and reference. Require `--from` when source ownership is ambiguous and `--contract` when several published contracts match.
2. Run once after confirmation:
   `singularity-flow capability depend <TARGET>@<REFERENCE> [--from <SOURCE>] [--contract <ID>] --json`.
3. Confirm the result records an exact version, content SHA-256, publication SHA-256, and publisher authority. A movable reference such as `latest` must not appear in authoritative dependency state.
4. Relay the proposal or refusal and stop. Never invent missing contract identity fields, activate, or edit YAML.
