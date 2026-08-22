---
name: sflow-story-checks
description: Record exact-SHA GitHub PR, Actions, lineage, freshness, and conformance evidence for the current finalized Story packet.
disable-model-invocation: true

---

# Record Story checks

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

1. Run `singularity-flow story branch status --json` to identify the parent Story and packet.
2. Run `singularity-flow story checks --parent <STORY-KEY> --packet <SHA-256> --json`.
3. Show each required check, its observed SHA, PR state, conformance freshness, and evidence hash.
4. Do not execute repository build or test code locally; this command reads governance and GitHub evidence.
5. If evidence is not ready, list exact blockers and do not approve.
