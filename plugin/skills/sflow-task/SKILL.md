---
name: sflow-task
description: Say what you want done; SFlow composes the steps from the kind of task and starts its Story.
disable-model-invocation: true
agent: agent
argument-hint: "<what you want done>"

---
# Do a task

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. No words: run `singularity-flow nextsteps --for-agent --json` once and show its first NOW action.
2. Name the kind from the person's words only: fix, feature, change, refactor, tests, docs, investigate, review or chore. A question about why something happens is investigate. Only when two kinds fit equally, ask_user once with those two as the choices.
3. Run `singularity-flow work "<the person's words, exactly>" --kind <KIND> --start --json` from cwd as is; a workspace folder is fine. Never choose an ID, base or workflow: SFlow does.
4. Say `data.task.plan` as one line. Never show a commit, digest or step ID.
5. On a refusal follow its `details.nextAction`; `TASK_KIND_UNKNOWN`: choose from `details.kinds` as in step 2 and run step 3 once more.
6. Show start's readiness lines, then relay `/sf-next` as the one next action.
