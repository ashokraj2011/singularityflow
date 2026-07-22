---
name: sflow-workflows
description: List, compare, simulate, or safely install bundled Singularity Flow workflow profiles.
argument-hint: "[list|simulate TYPE|diff TYPE|add TYPE --dry-run]"
disable-model-invocation: true
---
# Workflow catalog and simulation

Run `singularity-flow workflow $ARGUMENTS`. Default to `list` when no action is supplied. Before adding or upgrading a profile, run its simulation and diff, then use `--dry-run`. Show affected YAML and Markdown paths. Do not use `--replace` without explicit user confirmation, and do not commit configuration automatically.
