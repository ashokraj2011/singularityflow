---
name: sflow-epic-merge-plan
description: Show the dependency-safe merge sequence for finalized Epic Stories and the readiness of the Epic branch.
disable-model-invocation: true

---

# Show the Epic merge plan

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic merge-plan --epic <EPIC-KEY> --json`.
2. Display Story order, repository, blocking flag, dependencies, current state, and the next merge candidate.
3. Clearly separate unreachable, blocked, and ready Stories.
4. Report whether every blocking Story has merged and whether the Epic branch is ready.
5. This is read-only; do not merge, rebase, or push.
