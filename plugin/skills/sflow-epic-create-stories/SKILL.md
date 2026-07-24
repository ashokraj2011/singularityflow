---
name: sflow-epic-create-stories
description: Preview and execute an approved Epic Story write plan, creating idempotent Jira Stories and canonical Jira-key Git branches.
---

# Create Jira Stories and canonical branches

1. Confirm that the current materialization phase is approved (`epic-spec` for new Epics; `epic-plan` for immutable legacy Epics).
2. Ask which approved requirements/specification documents should be attached and whether Jira should receive them on the Epic, every Story, or both.
3. Run `singularity-flow epic create-stories --epic <EPIC-KEY> --artifact <PHASE/OUTPUT> --artifact-to <epic|stories|both>` to create the exact preview.
4. Display every operation, selected artifact filename/hash/target, title, acceptance criteria, repository, dependency, canonical branch, source hash, requirements hash, and exact plan SHA-256.
5. Ask the user to confirm the exact Epic key and exact plan hash. Never infer or autocomplete them.
6. Run `singularity-flow epic create-stories --epic <EPIC-KEY> --plan <SHA-256>` only after confirmation.
7. Show returned Jira numeric IDs and keys, attachment receipts, permanent temporary plan IDs, canonical branch receipts, seed commits, failures, retry guidance, and publication commits.
8. Never force-push, silently rename a Work ID after Jira re-keying, or create a duplicate after an idempotent receipt exists.
