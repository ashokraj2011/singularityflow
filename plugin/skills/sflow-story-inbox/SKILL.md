---
name: sflow-story-inbox
description: List active Jira Stories carrying governed Singularity lineage so a developer can choose work safely.
disable-model-invocation: true

---

# Developer Story inbox

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow story inbox --assigned-to-me`.
2. If the user asks for all visible governed Stories, omit `--assigned-to-me`.
3. Show Jira key/status, plan ID, Epic, configured repository, and canonical branch.
4. Ordinary Jira Stories without `com.singularity.flow.lineage` are intentionally excluded.
5. Do not change Jira assignment or status.
