---
name: sflow-initiative-checklist
description: Review an initiative phase checklist, evidence assurance, freshness, applicability decisions, and blocking gates in GitHub Copilot.
disable-model-invocation: true
argument-hint: "[PHASE] [--initiative INIT-ID]"
---
# Review an initiative checklist

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow initiative checklist [PHASE] [--initiative INIT-ID] --json`.
2. Show every checklist ID, requirement, gate mode, status, accepted assurance levels, current evidence hashes, expiration, and reason.
3. Clearly separate blocking errors from warnings and optional items.
4. For unmet checks, show an exact `singularity-flow initiative evidence add <CHECK-ID> ...` example without inventing evidence or assurance.
5. Use `singularity-flow initiative verify [PHASE]` only when the contributor asks for current verification.

Never turn file presence into higher assurance and never record a waiver or not-applicable decision without explicit user intent.
