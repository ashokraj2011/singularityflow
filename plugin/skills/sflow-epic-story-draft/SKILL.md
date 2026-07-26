---
name: sflow-epic-story-draft
description: Create the governed, repository-owned User Story package from approved Epic requirements and impact analysis, then stop for business review in the Singularity Flow UI before any Jira or Git Story publication.
---

# Draft Epic Stories

1. Run `singularity-flow epic planning status --json`. Stop if Requirements is not approved.
2. Run `singularity-flow epic planning prepare` and read the complete governed prompt, approved requirements, impact analysis, world-model views, and repository registry.
3. Author `story-plan.yml`, `parent-spec.md`, and one complete Story specification per `STORY-nnn`.
4. Give every Story a configured repository, workflow type, REQ/AC allocation, dependencies, test expectations, and implementation boundaries. Group Stories by owning repository. Do not invent Jira keys or assignees.
5. Run `singularity-flow epic planning publish`.
6. Run `singularity-flow epic stories validate` and print:
   - the parent specification;
   - every Story with repository, REQ/AC mappings, dependency, task count, and metadata;
   - every per-Story specification and its hash;
   - any validation failure.
7. Say exactly: **“The Story package is ready. I will proceed only after approval in the Singularity Flow UI.”**
8. Stop. Do not approve Planning, create or edit Jira issues, create Story branches, or invoke the publish skill.

The business reviewer may edit, split, add Jira tasks and metadata, or adopt an existing Jira Story in the UI. Those changes invalidate the former package hash and require renewed review.
