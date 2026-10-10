---
name: sflow-story-checks
description: Record exact-SHA GitHub repository-check, PR, lineage, freshness, and conformance evidence for the current finalized Story packet.
disable-model-invocation: true

---

# Record Story checks

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow story branch status --json` to identify the parent Story and packet.
2. Run `singularity-flow story checks --parent <STORY-KEY> --packet <SHA-256> --json`.
3. Show each required check, its observed SHA, PR state, conformance freshness, and evidence hash.
4. Do not execute repository build or test code locally; this command reads governance and configured GitHub repository evidence.
5. If evidence is not ready, list exact blockers and do not approve.
