---
name: sflow-environment
description: Inspect declared QA/UAT environment requirements and private binding readiness without exposing values.
disable-model-invocation: true
argument-hint: "status | audit | unbind <environment>"
---
# Inspect environment bindings safely

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow env status --json` for readiness or `singularity-flow env audit --json` when audit was requested.
2. Report environment names, bound/partial/unbound status, missing names, declaration digest, opaque binding revision, and fingerprint. Never print values, provider references, environment variables, private-sidecar paths, or raw resolver errors.
3. Never ask the user to paste a secret into Copilot Chat. To bind, give this terminal-only shape: `singularity-flow env bind <environment> --stdin`; explain that a bounded JSON object is read from standard input and the value must not be placed in argv or shell history.
4. Run `singularity-flow env unbind <environment> --json` only after the user explicitly requests removal and the exact environment is known. Report that private machine-local state was removed; the committed declaration is unchanged.
5. If an environment-bound check is unavailable because no approved isolated runner is active, preserve that status. Never substitute a developer-local pass or claim gate evidence.
