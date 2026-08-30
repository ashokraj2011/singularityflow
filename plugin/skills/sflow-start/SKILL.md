---
name: sflow-start
description: Explicitly choose a remote base, intake source, and workflow; create and publish the canonical Story branch.
disable-model-invocation: true
argument-hint: "<WORK-ID> [--jira | manual story details] [documents and URLs]"

---
# Start Singularity Flow work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → verified `repositoryPath`, cwd=`repositoryPath`; never `$HOME`; no active Story is required.

1. Require a work ID. Run `singularity-flow workspace current --json`; use its verified `repositoryPath` as every command's cwd. Run `singularity-flow version` and `git status --short`; on missing CLI or dirty tree, stop without installing or discarding.
2. Run `singularity-flow session candidates --json`. If the ID exists, route to `/sf-session` or `singularity-flow resume <WORK-ID>`; never start it again.
3. If `singularity/workflow.yml` is absent, run `singularity-flow init --work-id <WORK-ID> --base <BASE> --fetch`. It creates/reuses the Work-ID branch so protected `main` stays untouched. Stop for review and publication.
4. Run `singularity-flow workspace branches --json`. Require one branch published by every repository. Never infer or preselect it. Stop if a remote is unreachable.
5. Use `ask_user` for Jira or manual intake. Manual fields are `title`, `user`/audience, `problem`, `desiredOutcome`, `scope.in/out`, `stakeholders`, `urgency`, `constraints`, `dependencies`, `acceptanceCriteria`, `risks`, `notes`, and `documents[{path|url,label?,kind?}]`. Keep gaps as open questions. Never search the workspace, home directory, filesystem root, or temporary directories for an example. Write the story file outside tracked paths and use `--jira` or `--story-file` plus document flags.
6. Start a persistent shell with `--from-branch <SELECTED-BRANCH>`. At “Choose workflow template,” show exact options with `ask_user`, then send the selected number through `write_bash`. For `poc-workflow`, ask for the authorized URL and pass `--target-url`. The phase-default governed agent is automatic. If `ask_user` is unavailable or disabled, stop.
7. Without persistent input, run `singularity-flow choices begin start <WORK-ID> --json`. Present every choice including `base-branch`; record each with `singularity-flow choices answer <TOKEN> <CHOICE-ID> <OPTION-ID>`. If the recorded workflow is `poc-workflow`, collect the authorized target URL separately and include `--target-url <AUTHORIZED-URL>` with the final command. Start with `--selection-receipt <TOKEN>` only after `ready: true`; the receipt lasts 15 minutes and a successful start consumes the receipt exactly once.
8. Confirm base `<REMOTE>/<SELECTED-BRANCH>`, local branch `<WORK-ID>`, and published ref `<REMOTE>/<WORK-ID>`; the base ref must be unchanged. Report the durable Story files, phase, agent, inputs, and next action.
9. Do not generate the artifact unless requested. Offer `/sf-documents upload`, `/sf-nextsteps`, `/sf-next`, `/sf-help`, and `/sf-phase`.

`--jira` uses direct Jira REST through the npm utility and environment credentials. It does not use MCP or an IDE Jira plugin.
