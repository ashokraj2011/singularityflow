---
name: sflow-epic-journey
description: Explain the configured Epic lifecycle, current stage, governed artifacts, approval boundaries, and developer handoff as a business-readable journey.
disable-model-invocation: true

---

# Show the Epic journey

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic journey <EPIC-KEY> --json`.
2. Render Intake → Requirements → Planning → Story publication → developer delivery → Product Owner completion as an arrow flow.
3. Mark the current stage, completed gates, artifacts, owners, and cross-repository handoffs.
4. Distinguish business review in the VS Code extension's Approvals view from work performed through Copilot skills.
5. Do not change lifecycle state.
