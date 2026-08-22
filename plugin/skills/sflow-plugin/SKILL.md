---
name: sflow-plugin
description: Inspect, install, or uninstall the packaged Singularity Flow Copilot plugin without touching governed repositories.
disable-model-invocation: true
argument-hint: "list|path|install|uninstall"
---
# Manage the Copilot plugin

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

1. Run `singularity-flow plugin list` or `singularity-flow plugin path` before changing installation state.
2. For install or uninstall, show the exact plugin identity and target path and require an explicit request.
3. Run only the requested `singularity-flow plugin install|uninstall` command and relay discovery or restart guidance.
4. Never remove personal skills, edit a governed repository, or substitute a full reinstall unless the user asks for that broader operation.

