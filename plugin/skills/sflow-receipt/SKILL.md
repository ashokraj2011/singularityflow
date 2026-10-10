---
name: sflow-receipt
description: Replay compact evidence for a submitted phase.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---
# Show a Singularity Flow evidence receipt

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Run `singularity-flow receipt show --work-id <WORK-ID> --json`, using the supplied Work ID or the attached Story. Report the exact phase and generation, source commit, changed-path count, requirement coverage, checks, approvals, governed context, publication state, review-packet hash, and receipt hash. Never turn unavailable evidence into zero or success. If the user asks for a review-ready form, run the same command with `--markdown` and display the complete bounded Markdown.
