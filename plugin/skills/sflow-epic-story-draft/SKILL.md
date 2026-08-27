---
name: sflow-epic-story-draft
description: Create the governed, repository-owned User Story package from approved Epic requirements and impact analysis, then stop for business review in the Singularity Flow UI before any Jira or Git Story publication.
disable-model-invocation: true

---

# Draft Epic Stories

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow epic planning status --json`. Stop if Requirements is not approved.
2. Run `singularity-flow epic planning prepare` and read the complete governed prompt, approved requirements, impact analysis, pinned source evidence, and workspace repository registry. Do not request a world model on the Epic branch.
3. Before drafting, ask one concise batch about any material allocation, repository ownership, dependency, boundary, or acceptance ambiguity. Wait for the human and persist each accepted response with `singularity-flow epic sources answer --epic <EPIC-ID>`; then rerun `singularity-flow epic planning prepare` so the answers become pinned governed context. If questions cannot be asked or persisted, stop rather than infer Story boundaries.
4. Author `story-plan.yml`, `parent-spec.md`, and one complete Story specification per `STORY-nnn`.
5. Give every Story a configured repository, workflow type, REQ/AC allocation, dependencies, test expectations, and implementation boundaries. Group Stories by owning repository. Do not invent Jira keys or assignees.
6. Run `singularity-flow epic planning publish`.
7. Run `singularity-flow epic stories validate` and print:
   - the parent specification;
   - every Story with repository, REQ/AC mappings, dependency, task count, and metadata;
   - every per-Story specification and its hash;
   - any validation failure.
8. Say exactly: **“The Story package is ready. I will proceed only after approval in the Singularity Flow UI.”**
9. Stop. Do not approve Planning, create or edit Jira issues, create Story branches, or invoke the publish skill.

The business reviewer may edit, split, add Jira tasks and metadata, or adopt an existing Jira Story in the UI. Those changes invalidate the former package hash and require renewed review.
