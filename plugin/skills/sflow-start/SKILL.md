---
name: sflow-start
description: Explicitly choose a remote base, intake source, and workflow; create and publish the canonical Story branch.
disable-model-invocation: true
argument-hint: "<WORK-ID> [--jira | manual story details] [documents and URLs]"

---
# Start Singularity Flow work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.

1. Require an explicit work ID. Run `singularity-flow version` and `git status --short`; report missing CLI or dirty-tree failures without installing or discarding anything.
2. Before collecting intake, run `singularity-flow session candidates --json`. If the ID exists, report it and route to `/sf-session` or `singularity-flow resume <WORK-ID>`; do not start it again.
3. If `singularity/workflow.yml` is absent, run `singularity-flow init --work-id <WORK-ID> --base <BASE> --fetch`. It must create/reuse the Work-ID branch before configuration so protected `main` is untouched. Stop for review, commit, and push of those initialized assets.
4. Run `singularity-flow workspace branches --json`. Require the contributor to select one branch published by every required repository. Never infer or preselect even when only one branch is available. If any remote is unreachable, stop before collecting the rest of intake.
5. Use `ask_user` to choose Jira or manual intake. For manual intake, collect the fields in `examples/manual-story.yml` plus supplied files/URLs and keep missing facts as open questions. Write the story file outside tracked paths. Use `--jira` or `--story-file`; repeat document flags as needed.
6. Start in a persistent interactive shell and pass `--from-branch <SELECTED-BRANCH>`. At “Choose workflow template,” display the exact options with `ask_user`, then send the contributor's selected number to that same process with `write_bash`. If `poc-workflow` is selected, ask for the exact authorized target URL and pass `--target-url <AUTHORIZED-URL>`; do not infer it. Never infer or preselect a choice. The workflow's phase-default governed agent is automatic, not a human identity or approval authority. If `ask_user` is unavailable or disabled, stop.
7. Without persistent input, run `singularity-flow choices begin start <WORK-ID> --json`. Present every choice including `base-branch`; record each with `singularity-flow choices answer <TOKEN> <CHOICE-ID> <OPTION-ID>`. If the recorded workflow is `poc-workflow`, collect the authorized target URL separately and include `--target-url <AUTHORIZED-URL>` with the final command. Start with `--selection-receipt <TOKEN>` only after `ready: true`; the receipt lasts 15 minutes and a successful start consumes the receipt exactly once.
8. Confirm base `<REMOTE>/<SELECTED-BRANCH>`, local branch `<WORK-ID>`, and published ref `<REMOTE>/<WORK-ID>`; the base ref must be unchanged. Report the durable Story files, phase, agent, inputs, and next action.
9. Do not generate the artifact unless requested. Offer `/sf-documents upload`, `/sf-nextsteps`, `/sf-next`, `/sf-help`, and `/sf-phase`.

`--jira` uses direct Jira REST through the npm utility and environment credentials. It does not use MCP or an IDE Jira plugin.
