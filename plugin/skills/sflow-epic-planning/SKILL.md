---
name: sflow-epic-planning
description: Turn approved Epic requirements and impact evidence into an editable Story plan, parent specification, and exact per-Story specifications.
---

# Plan governed Stories

1. Run `singularity-flow epic planning status --json` and confirm Requirements is approved.
2. Run `singularity-flow epic planning prepare` and read the complete governed prompt.
3. Produce `story-plan.yml`, `parent-spec.md`, and the Story specification index. Every Story needs an immutable `STORY-nnn`, configured repository, pinned workflow type, REQ/AC allocation, dependencies, test expectations, and a complete embedded specification.
4. Let the user review and edit the Story list. Jira assignment is deliberately excluded; assignment remains in Jira after creation.
5. Run `singularity-flow epic planning publish`. Singularity materializes and hash-registers one `stories/<PLAN-ID>/story-spec.md` per Story and validates repository ownership, coverage, IDs, and dependency acyclicity.
6. Print the parent specification, Story table, every Story specification, changed hashes, and validation failures.
7. Say exactly: **“The Story package is ready. I will proceed only after approval in the Singularity Flow UI.”**
8. Stop. Do not approve the package or create Jira/Git Stories. The UI owns the business review, edits, splits, task/metadata configuration, direct Story adoption, and exact approval.
