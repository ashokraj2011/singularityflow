---
name: sflow-start
description: Interactively choose Jira or manual intake and a workflow template; activate its phase-default agent and publish durable Singularity Flow state.
disable-model-invocation: true
argument-hint: "<WORK-ID> [--jira | manual story details] [documents and URLs]"

---
# Start Singularity Flow work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.

1. Require an explicit work ID. Run `singularity-flow version` and `git status --short`; report missing CLI or dirty-tree failures without installing or discarding anything.
2. Check whether the work item already exists, before collecting anything. Run `singularity-flow session candidates --json`. If the ID is listed, this is existing work: say so, report its phase and status, and route to `/sf-session` to attach — or `singularity-flow resume <WORK-ID>` for the branch alone — then end the turn. Do not ask about intake. `start` refuses an existing ID anyway, so asking first only spends the contributor's answers on a command that cannot use them.
3. If `singularity/workflow.yml` is absent, run `singularity-flow init --work-id <WORK-ID> --base <BASE> --fetch`. It must create/reuse the Work-ID branch before configuration so protected `main` is untouched. Stop for review, commit, and push of those initialized assets.
4. Collect source before workflow. Use `ask_user` to choose Jira or manual intake. For manual intake, collect title, audience, problem, outcome, scope, constraints, dependencies, acceptance criteria, risks, notes, and supplied files/URLs; keep missing facts as open questions. Write a temporary story file outside tracked paths using `examples/manual-story.yml`. Use `--jira` for Jira or `--story-file <file>` for manual input; repeat `--document` and `--document-url` as needed.
5. Start in a persistent interactive shell. For `Choose intake source` and `Choose workflow template`, display the exact options with `ask_user`, then send the contributor's selected number to that same process with `write_bash`. Never infer or preselect a choice. The workflow's phase-default governed agent is automatic, not a human identity or approval authority. If `ask_user` is unavailable or disabled, stop.
6. If persistent input is unavailable, run `singularity-flow choices begin start <WORK-ID> --json`. Present every `choiceSets` group with `ask_user`; record each exact answer using `singularity-flow choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`. The token expires after 15 minutes. Once `ready: true`, rerun start with `--selection-receipt <TOKEN>`. The CLI validates and consumes the receipt exactly once; never construct an answer.
7. Confirm branch = work ID. Read `workflow.json`, `STATUS.md`, `source.json`, `USER-STORY.md`, and `documents.json` when present. Report source, `DOC-nnn` inputs, current phase/artifact, open questions, phase agent, and next action.
8. Do not generate the artifact unless requested. Offer `/sf-documents upload`, `/sf-nextsteps`, `/sf-next`, `/sf-help`, and `/sf-phase`.

`--jira` uses direct Jira REST through the npm utility and environment credentials. It does not use MCP or an IDE Jira plugin.
