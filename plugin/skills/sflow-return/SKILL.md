---
name: sflow-return
description: Safely reconstruct a published Story on this machine from durable remote evidence.
disable-model-invocation: true
agent: agent
argument-hint: "<WORK-ID>"

---
# Return to published governed work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Run `singularity-flow return <WORK-ID> --json` first. Show the configured remote, source ref, destination branch, freshness, and whether the worktree is clean. If it is dirty, stop; never stash, reset, clean, commit, or discard changes. Ask the user to explicitly confirm the exact Work ID. Only after they provide it, run `singularity-flow return <WORK-ID> --apply --confirm <WORK-ID>`. Report the reconstructed phase and governed agent, then refresh with `/sf-home`. Never generate the confirmation yourself and never substitute `singularity-flow resume` when the Story must be discovered from another machine.
