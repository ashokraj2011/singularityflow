---
name: sflow-epic-publish
description: Preview and apply the exact approved Jira and Git Story publication plan with lineage properties, comments, specifications, and branch receipts.
---

# Publish Stories to Jira and Git

1. Confirm the combined Planning package is approved.
2. Ask which approved artifacts should also be attached and whether their target is the Epic, Stories, or both.
3. Run `singularity-flow epic jira preview --epic <EPIC-KEY> [--artifact <PHASE/OUTPUT>] [--artifact-to epic|stories|both]`.
4. Display every Jira field, parent link, visible lineage comment, `com.singularity.flow.lineage` property, attachment, repository, canonical branch, specification hash, and exact write-plan SHA-256.
5. Require explicit confirmation of the Epic key and exact plan hash.
6. Run `singularity-flow epic jira apply --epic <EPIC-KEY> --plan <SHA-256>`.
7. Show Jira IDs/keys, `STORY-nnn` lineage, canonical branches, governed context paths and hashes, Git/Jira receipts, failures, and safe retry guidance.
8. Never follow an unconfigured repository URL, force-push, assign a Story, or duplicate an operation with an existing matching receipt.
