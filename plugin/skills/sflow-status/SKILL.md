---
name: sflow-status
description: Show the current phase, artifacts, checks, and approvals.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---
# Show Singularity Flow status

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Run `singularity-flow status` with the supplied work ID, if any. Read `STATUS.md` and report the branch, immutable work type, current phase, suggested governed agents, generation, artifacts, token usage, human approval authority groups, threshold, self-approval warnings, publication state, and next valid action. Do not change files or lifecycle state.
