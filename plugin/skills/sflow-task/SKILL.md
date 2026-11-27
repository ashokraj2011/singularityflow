---
name: sflow-task
description: Say what you want done; SFlow writes the requirement first, sizes the task (small, big or analysis) and starts its Story.
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

1. When this turn's SFlow turn boundary names a Story, this turn is its next action, whatever words follow. They are the person's answer or change, unless they start "new task". Run `singularity-flow nextsteps --for-agent --json` once; its first NOW action decides:
   - a person's approval (skill `/sf-approve`): run `singularity-flow choices begin approve <WORK-ID> --fetch --for-agent --json --review-packet`, ask its `act.ask` question with ask_user, and on the person's own Yes (never yours) run its `onYes` commands in order. Asked for a big change instead: run `singularity-flow work shape big --json`, say its `words`, begin again.
   - a decision (skill `/sf-decide`): show its route; the person decides it on the decisions card.
   - anything else: do the current step's own work in this turn, from `singularity-flow phase enter --compose --for-agent --json` to its own boundary, as `/sf-next` does.
   When SFlow's note says this turn goes on, do step 1 again. No note after a start, submission or approval: run `singularity-flow work status <WORK-ID> --json`; `taskTurn.carriedBy` `skill` (no hook ran) means do step 1 again too.
   Words that ask for another step ("add a design step"): run `singularity-flow work add <STEP> --json` first and say its `words`, then carry on as above.
   Then say in one line what finished and what is next: `/sf-task`, typed in this chat. When the Story has no step left, run `singularity-flow work status --json`: say its `words`, what the person approved, and link each step's `document`; when `pullRequest` is true, open it as in step 2; with `followUps`, ask_user its `ask`, each `title` a choice, and No; on a choice run its `command`, then step 5.
2. Words that ask for a pull request when the Story has no step left: run `singularity-flow pr <WORK-ID> --json`, show its head, base and title, then `singularity-flow pr <WORK-ID> --create --yes`, and give its link. No new task.
3. Otherwise (no Story open, or words beginning "new task"): with no words run `singularity-flow work list --json`, say its `say`, ask_user what to do. Name the kind from the person's words only: fix, feature, change, refactor, tests, docs, investigate, review or chore. A question about why something happens is investigate. Only when two kinds fit equally, ask_user once with those two as the choices.
4. Run `singularity-flow work "<the person's words, exactly>" --kind <KIND> --start --json` from cwd as is (add `--new` only after "new task"; "fix it" after an investigation or review in this chat: `--from <ITS-ID>`; a document the person names: `--document <PATH>`; "add a design step" or "skip the plan": `--add <STEP>` or `--skip <STEP>`); a workspace folder is fine. Never choose an ID, base or workflow: SFlow does.
5. Say `data.task.plan` as one line. A refactor: run `data.task.before` once now, before any edit, and say in one line which tests already fail on the base.
6. On a refusal follow its `details.nextAction`; `TASK_OPEN_HERE`: do step 1 with the person's words; `TASK_KIND_UNKNOWN`: choose from `details.kinds` as in step 3 and run step 4 once more.
   `TASK_AGENT_YES_NEEDED` (its `details.agentOffer`) and `TASK_SKILL_YES_NEEDED` (each of `details.offers`): run its `show` when it has one and show the source and the full `text` (an agent's: `review.markdown`), the one exception to the no-paste rule; ask_user its `ask` with Yes and No. On the person's own Yes to a shown one, run that preview's `addCommand` with `--propose --json` (an agent's: `singularity-flow workflow import <bundlePath> --confirm <importPlan.planSha256> --propose --json`); its import is reviewed: this task keeps the `no`. Any other Yes keeps its `yes`; a No keeps its `no`. Then run `details.start` once with every kept option added.
7. Say `data.readiness` in one line only if its `status` is `blocked`. When SFlow's note says this turn goes on, do step 1 with no words; else say `/sf-task`, typed in this chat, carries it on.
