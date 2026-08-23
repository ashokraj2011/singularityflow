---
name: sflow-workflows
description: List, compare, simulate, or safely install bundled Singularity Flow workflow profiles.
disable-model-invocation: true
argument-hint: "[list|simulate TYPE|diff TYPE|add TYPE --dry-run]"

---
# Workflow catalog and simulation

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

Run `singularity-flow workflow $ARGUMENTS`. Default to `list` when no action is supplied. Before adding or upgrading a profile, run its simulation and diff, then use `--dry-run`. Show affected YAML and Markdown paths. Do not use `--replace` without explicit user confirmation, and do not commit configuration automatically.
