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

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. When this turn's SFlow turn boundary names a Story, a task is open here: this turn is its next action, whatever words follow. They are the person's answer, or the change they want, unless they begin with "new task". Run `singularity-flow nextsteps --for-agent --json` once; its first NOW action decides:
   - a person's approval (`/sf-approve`): run `singularity-flow choices begin approve <WORK-ID> --fetch --for-agent --json --review-packet`, ask its `act.ask` question with ask_user, and on the person's own Yes run its `onYes` commands in order. Never answer it yourself.
   - a decision (`/sf-decide`): show its route; the person decides it on the decisions card.
   - anything else: do the current step's own work in this turn, from `singularity-flow phase enter --compose --for-agent --json` to its own boundary, as `/sf-next` does.
   Then say in one line what finished and what comes next. When the Story has no step left, say what was done and where it is, which checks ran, and what the person approved.
2. Words that ask for a pull request when the Story has no step left: run `singularity-flow pr <WORK-ID> --json`, show its head, base and title, then `singularity-flow pr <WORK-ID> --create --yes`, and give its link. No new task.
3. Otherwise (no Story open, or words beginning "new task") name the kind from the person's words only: fix, feature, change, refactor, tests, docs, investigate, review or chore. A question about why something happens is investigate. Only when two kinds fit equally, ask_user once with those two as the choices.
4. Run `singularity-flow work "<the person's words, exactly>" --kind <KIND> --start --json` from cwd as is (add `--new` only after "new task"); a workspace folder is fine. Never choose an ID, base or workflow: SFlow does.
5. Say `data.task.plan` as one line. Never show a commit, digest or step ID.
6. On a refusal follow its `details.nextAction`; `TASK_OPEN_HERE`: do step 1 with the person's words; `TASK_KIND_UNKNOWN`: choose from `details.kinds` as in step 3 and run step 4 once more.
7. Show start's readiness lines in one line, then `/sf-task` as what carries the task on.
