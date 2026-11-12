---
name: sflow-epic-publish
description: Preview and apply the exact approved Jira and Git Story publication plan with lineage properties, comments, specifications, and branch receipts.
disable-model-invocation: true
agent: agent

---

# Publish Stories to Jira and Git

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow epic next <EPIC-KEY> --for-agent --json`; continue only when it returns the `materialize` action; its `/sf-epic-publish` route is this run, never one to relay.
2. Ask which approved artifacts should also be attached and whether their target is the Epic, Stories, or both.
3. Run `singularity-flow epic jira preview --epic <EPIC-KEY> [--artifact <PHASE/OUTPUT>] [--artifact-to epic|stories|both]`.
4. Display every Jira field, parent link, visible lineage comment, `com.singularity.flow.lineage` property, attachment, repository, and canonical branch.
5. Require explicit confirmation of the Epic key, and of the exact write plan when the preview returned one (a local Epic has no Jira plan).
6. Only after that exact confirmation, run `singularity-flow epic jira apply --epic <EPIC-KEY> --plan <SHA-256> --confirm <EPIC-KEY>` (local Epic: omit `--plan`).
7. Show Jira IDs/keys, `STORY-nnn` lineage, created Jira tasks, canonical branches, governed context paths, Git/Jira receipts, failures, and safe retry guidance.
8. When every Jira/Git receipt is present, confirm that Epic planning is complete and developer delivery tracking is open. Tell developers to use `/sf-story-fetch <STORY-KEY>` with each Story's Jira key, or for a local Epic the Story key in its receipt.
9. Never follow an unconfigured repository URL, force-push, assign a Story, alter the parent of a directly adopted Jira Story, or duplicate an operation with an existing matching receipt.
