---
name: sflow-approvals
description: Show the phase-by-phase approval chain, document names, authority groups, reviewers, decisions, and outstanding thresholds.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Show the approval chain

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow approvals $ARGUMENTS --json`.
2. Show every phase, governed document, required authority group, approval threshold, recorded reviewer identity, decision, and current wait state.
3. Preserve self-approval and identity warnings exactly.
4. This skill is read-only. Offer `/sf-inbox` to select pending review work and `/sf-approve` or `/sf-reject` only when the user explicitly wants to decide.

