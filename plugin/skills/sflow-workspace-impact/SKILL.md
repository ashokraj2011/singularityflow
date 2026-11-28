---
name: sflow-workspace-impact
description: Run or inspect an advisory impact analysis across the selected workspace without creating a Work ID or lifecycle branch.
disable-model-invocation: true
agent: agent

---

# Analyze workspace impact

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: advisory-analysis -->
**Output contract:** Run only the confirmed advisory analysis; report its evidence and limitations. Do not promote or publish governed artifacts. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow workspace current --json`. If no workspace is active, stop and use `/sf-workspace` to let the contributor select one; do not infer a workspace from the current repository.
2. Ask for a concise change description and optional title. Let the contributor narrow the analysis to repository, capability, or staged-document IDs; otherwise explain that all workspace repositories and staged documents are used.
3. Before spending Copilot tokens, run `singularity-flow workspace impact analyze <WORKSPACE-PATH> --description <TEXT> [--title <TITLE>] [--repository <ID>]... [--capability <ID>]... [--document <PATH>]... --dry-run --json`. Show the exact revisions, dirty-working-tree warnings, and selected documents.
4. Ask the contributor to confirm that the advisory analysis should run. Then execute the same command without `--dry-run`. This intentionally starts a separate non-interactive Copilot analysis process over disposable detached clones; never inspect or edit the contributor's live checkout yourself.
5. Give a concise summary and verified Markdown-preview link, analysis ID, captured repository commits, freshness, model/token status and warnings; never reproduce the report body. Never claim that the result is approved, governed, or implementation-ready.
6. Offer `singularity-flow workspace impact promote <WORKSPACE-PATH> <ANALYSIS-ID> --json` to copy a current report into the workspace document inbox. Do not promote automatically. Promotion still does not create a Work ID or branch; governed intake happens only when the contributor starts a Story or Initiative.
7. Use `singularity-flow workspace impact list <WORKSPACE-PATH> --json` and `singularity-flow workspace impact show <WORKSPACE-PATH> <ANALYSIS-ID> --json` for later inspection. Clearly label a report stale when any captured repository revision or saved analysis artifact changed.
