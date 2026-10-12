---
name: sflow-epic-publish
description: Preview and apply the exact approved Jira and Git Story publication plan with lineage properties, comments, specifications, and branch receipts.
disable-model-invocation: true

---

# Publish Stories to Jira and Git

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic next <EPIC-KEY> --json`; continue only when it returns the `materialize` action.
2. Ask which approved artifacts should also be attached and whether their target is the Epic, Stories, or both.
3. Run `singularity-flow epic jira preview --epic <EPIC-KEY> [--artifact <PHASE/OUTPUT>] [--artifact-to epic|stories|both]`.
4. Display every Jira field, parent link, visible lineage comment, `com.singularity.flow.lineage` property, attachment, repository, canonical branch, specification hash, and exact write-plan SHA-256.
5. Require explicit confirmation of the Epic key, and of the exact plan hash when the preview returned one (a local Epic has no Jira plan).
6. Only after that exact confirmation, run `singularity-flow epic jira apply --epic <EPIC-KEY> --plan <SHA-256> --confirm <EPIC-KEY>` (local Epic: omit `--plan`).
7. Show Jira IDs/keys, `STORY-nnn` lineage, created Jira tasks, canonical branches, governed context paths and hashes, Git/Jira receipts, failures, and safe retry guidance.
8. When every Jira/Git receipt is present, confirm that Epic planning is complete and developer delivery tracking is open. Tell developers to use `/sf-story-fetch <JIRA-KEY>`.
9. Never follow an unconfigured repository URL, force-push, assign a Story, alter the parent of a directly adopted Jira Story, or duplicate an operation with an existing matching receipt.
