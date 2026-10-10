---
name: sflow-validate
description: Validate the selected Singularity Flow repository without changing workflow or Git state.
disable-model-invocation: true

---
# Validate the selected repository

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. In the Boundary repository run `singularity-flow validate` exactly once.
2. Report the validation result without rewriting, repairing, initializing, publishing, committing, or pushing anything.
3. If validation refuses, preserve its Shell and Copilot remediation routes. Do not execute either route unless the user separately requests that action.
4. Stop after the read-only result.
