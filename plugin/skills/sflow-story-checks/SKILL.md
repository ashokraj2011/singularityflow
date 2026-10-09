---
name: sflow-story-checks
description: Record exact-SHA GitHub repository-check, PR, lineage, freshness, and conformance evidence for the current finalized Story packet.
disable-model-invocation: true

---

# Record Story checks

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow story branch status --json` to identify the parent Story and packet.
2. Run `singularity-flow story checks --parent <STORY-KEY> --packet <SHA-256> --json`.
3. Show each required check, its observed SHA, PR state, conformance freshness, and evidence hash.
4. Do not execute repository build or test code locally; this command reads governance and configured GitHub repository evidence.
5. If evidence is not ready, list exact blockers and do not approve.
