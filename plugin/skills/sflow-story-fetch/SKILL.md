---
name: sflow-story-fetch
description: Securely fetch a governed Jira Story branch, verify its parent and Story specifications, and start its pinned repository workflow.
disable-model-invocation: true
agent: agent

---

# Fetch a governed Story

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Ask the user to choose a Story from `/sf-story-inbox`.
2. Run `singularity-flow story fetch <JIRA-KEY>`. If it belongs to another configured repository, provide the user's chosen local directory through `--directory`.
3. The command must resolve repository identity only through the workspace allowlist, fast-forward the canonical branch, and verify the seed and every governed-context hash.
4. Let the governed-agent picker complete. The workflow type is already pinned by the approved Story plan.
5. Show Epic → plan ID → Jira Story lineage, local directory, workflow type, current phase, and next action.
6. Never override an unlisted URL, a remote mismatch, a divergent branch, or a specification hash mismatch.
