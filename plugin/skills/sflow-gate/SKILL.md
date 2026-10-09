---
name: sflow-gate
description: Run the final deterministic governance gate and explain every blocking check without bypassing it.
disable-model-invocation: true
argument-hint: "[--terminal]"
---
# Run the governance gate

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow gate $ARGUMENTS` exactly once.
2. Preserve every configuration, artifact, approval, traceability, conformance, protected-path, quality-command, and remote-state finding.
3. Distinguish a failed gate from a command crash and show the exact remediation supplied by the engine.
4. Do not edit lifecycle state, waive checks, approve, retry repeatedly, or claim merge readiness unless the terminal gate passes.

