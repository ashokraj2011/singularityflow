---
name: sflow-capability-protect
description: Propose one path protection and its approval obligation atomically.
disable-model-invocation: true
agent: agent
argument-hint: "<PATH> --approver <GROUP>"
---
# Protect a capability path

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (VS Code: Continue).
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Require one repository-relative path. Run `singularity-flow capability show <PATH> --json`.
2. Require an explicit approval group when the CLI cannot resolve exactly one.
3. After confirmation, run once:
   `singularity-flow capability protect <PATH> --approver <GROUP> [--reason <TEXT>] --json`.
4. Relay the exact review branch and receipt, then the next action the CLI names for that proposal: review with `singularity-flow capability proposal <BRANCH> --lead <LEAD-URL> --json`; after approval, activation through `/sf-capability-map` (`singularity-flow capability activate <BRANCH> --lead <LEAD-URL> --confirm <COMMIT> --json`). Stop; never split the path rule from its approval, activate the proposal yourself, or edit YAML.
