---
name: sflow-stack
description: Show or synchronize the dependency-safe Story pull-request and merge stack for an Epic.
disable-model-invocation: true
agent: agent

---

# Govern the Story merge stack

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

For status from a Story repository, run:

`singularity-flow stack status --json`

`status: not-applicable` means the Story is not in an Epic merge stack; say so and stop.

From the Epic lead repository, refresh live Git state and replicate the resulting stack to every participating repository's orphan state branch:

`singularity-flow stack sync --epic <EPIC-ID> --json`

Display the deterministic order, repository, status, blockers, next Story to merge, unreachable branches, and Epic readiness. Explain that the state branch is a control plane with no application ancestry and must never be merged into `main` or an Epic branch.

Do not merge or force-push. After a Story merge, synchronize the stack again before opening the next pull request.
