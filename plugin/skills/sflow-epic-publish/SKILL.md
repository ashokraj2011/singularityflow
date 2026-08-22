---
name: sflow-epic-publish
description: Preview and apply the exact approved Jira and Git Story publication plan with lineage properties, comments, specifications, and branch receipts.
disable-model-invocation: true

---

# Publish Stories to Jira and Git

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

1. Confirm the combined Planning package is approved.
2. Ask which approved artifacts should also be attached and whether their target is the Epic, Stories, or both.
3. Run `singularity-flow epic jira preview --epic <EPIC-KEY> [--artifact <PHASE/OUTPUT>] [--artifact-to epic|stories|both]`.
4. Display every Jira field, parent link, visible lineage comment, `com.singularity.flow.lineage` property, attachment, repository, canonical branch, specification hash, and exact write-plan SHA-256.
5. Require explicit confirmation of the Epic key and exact plan hash.
6. Run `singularity-flow epic jira apply --epic <EPIC-KEY> --plan <SHA-256>`.
7. Show Jira IDs/keys, `STORY-nnn` lineage, created Jira tasks, canonical branches, governed context paths and hashes, Git/Jira receipts, failures, and safe retry guidance.
8. When every Jira/Git receipt is present, confirm that Epic planning is complete and developer delivery tracking is open. Tell developers to use `/sf-story-fetch <JIRA-KEY>`.
9. Never follow an unconfigured repository URL, force-push, assign a Story, alter the parent of a directly adopted Jira Story, or duplicate an operation with an existing matching receipt.
