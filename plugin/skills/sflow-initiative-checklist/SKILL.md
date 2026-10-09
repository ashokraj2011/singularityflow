---
name: sflow-initiative-checklist
description: Review an initiative phase checklist, evidence assurance, freshness, applicability decisions, and blocking gates in GitHub Copilot.
disable-model-invocation: true
argument-hint: "[PHASE] [--initiative INIT-ID]"
---
# Review an initiative checklist

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow initiative checklist [PHASE] [--initiative INIT-ID] --json`.
2. Show every checklist ID, requirement, gate mode, status, accepted assurance levels, current evidence hashes, expiration, and reason.
3. Clearly separate blocking errors from warnings and optional items.
4. For unmet checks, show an exact `singularity-flow initiative evidence add <CHECK-ID> ...` example without inventing evidence or assurance.
5. Use `singularity-flow initiative verify [PHASE]` only when the contributor asks for current verification.

Never turn file presence into higher assurance and never record a waiver or not-applicable decision without explicit user intent.
