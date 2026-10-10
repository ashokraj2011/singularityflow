---
name: sflow-finalize
description: Finalize a fully approved developer Story into an exact hash-bound packet for Product Owner spec-to-code review.
disable-model-invocation: true

---

# Finalize a Story

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow progress` and confirm every configured Story phase is approved.
2. Run `singularity-flow finalize`.
3. The command verifies a clean tree, the governed seed, parent and Story specification hashes, every phase artifact, approvals, quality evidence, model/token records, and exact source/test tree.
4. Show the finalization packet path/hash, source commit/tree hash, commit, and push.
5. Do not approve or promote the Story. Finalization changes delivery state to `finalized_for_review`; Product Owner review is a separate decision.
