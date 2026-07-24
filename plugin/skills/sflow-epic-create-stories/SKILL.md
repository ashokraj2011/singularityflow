---
name: sflow-epic-create-stories
description: Preview and execute an approved Epic Story write plan, creating idempotent Jira Stories and canonical Jira-key Git branches.
---

# Create Jira Stories and canonical branches

1. Confirm that `epic-plan` is approved and run `singularity-flow epic create-stories --epic <EPIC-KEY>`.
2. Display every operation, title, acceptance criteria, repository, dependency, canonical branch, source hash, requirements hash, and exact plan SHA-256.
3. Ask the user to confirm the exact Epic key and exact plan hash. Never infer or autocomplete them.
4. Run `singularity-flow epic create-stories --epic <EPIC-KEY> --plan <SHA-256>` only after confirmation.
5. Show returned Jira numeric IDs and keys, permanent temporary plan IDs, canonical branch receipts, seed commits, failures, retry guidance, and publication commits.
6. Never force-push, silently rename a Work ID after Jira re-keying, or create a duplicate after an idempotent receipt exists.
