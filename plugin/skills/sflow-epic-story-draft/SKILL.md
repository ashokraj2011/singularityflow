---
name: sflow-epic-story-draft
description: Create the governed, repository-owned User Story package from approved Epic requirements and impact analysis, then stop for business review in the Singularity Flow UI before any Jira or Git Story publication.
disable-model-invocation: true

---

# Draft Epic Stories

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Author configured artifacts from governed inputs and pinned clarification; publish only after readiness. Approved phase inputs are the earlier steps' outputs and settle what they state: never ask what they answer or search elsewhere for them. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. When a result's `act.state` is `author`, or it routes back to this skill with nothing for a person to answer, edit, review or confirm, that is this turn's own work: do it, never relay it. A file edit that does not match is not a refusal: read the file again and redo the edit.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow epic next <EPIC-ID> --for-agent --json`; continue only when it routes to Planning preparation, otherwise relay its action and stop.
2. Run `singularity-flow epic planning prepare` and read the complete governed prompt, approved requirements, impact analysis, pinned source evidence, and workspace repository registry. Do not request a world model on the Epic branch.
3. Before drafting, ask one concise batch about any material allocation, repository ownership, dependency, boundary, or acceptance ambiguity. Wait for the human and persist each accepted response with `singularity-flow epic sources answer --epic <EPIC-ID> --text-file <FILE>`, writing FILE only at the source-text draft this turn's rules name; then rerun `singularity-flow epic planning prepare` so the answers become pinned governed context. If questions cannot be asked or persisted, stop rather than infer Story boundaries.
4. Author `story-plan.yml` and `parent-spec.md` at the exact paths step 2's prepare returned, with one complete Story `specification` per `STORY-nnn` in `story-plan.yml`; publication writes each `stories/<PLAN-ID>/story-spec.md` from it.
5. Give every Story a configured repository, workflow type, REQ/AC allocation, dependencies, test expectations, and implementation boundaries. Group Stories by owning repository. Do not invent Jira keys or assignees.
6. Run `singularity-flow epic planning publish`.
7. Run `singularity-flow epic stories validate`. On failure, fix only the files you authored from governed evidence, republish and revalidate, at most twice; then relay the remaining failures and stop.
8. Summarize with verified preview links and hashes, never bodies: the parent specification; every Story with repository, REQ/AC mappings, dependency, task count, and metadata; every per-Story specification.
9. Only when validation passes, say exactly: **“The Story package is ready. I will proceed only after approval in the Singularity Flow UI or with `/sf-initiative-approve phase --initiative <EPIC-ID>`.”** In their own terminal the reviewer can run `singularity-flow initiative approve phase --initiative <EPIC-ID>`. After approval, the next turn is `/sf-epic-publish`.
10. Stop. Do not approve Planning, create or edit Jira issues, create Story branches, or invoke the publish skill.

The business reviewer may edit, split, add Jira tasks and metadata, or adopt an existing Jira Story in the UI. Those changes invalidate the former package hash and require renewed review.
