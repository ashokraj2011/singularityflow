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
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require a work ID. Use the opened root from `git rev-parse --show-toplevel`, else `workspace current --json`'s `repositoryPath`. Refuse if neither resolves; never search home/parents. There run `singularity-flow version` and `git status --short`; stop on missing CLI or dirt.
2. Run `singularity-flow session candidates --json`. If the ID exists, route to `/sf-session` or `singularity-flow resume <WORK-ID>`; never start it again.
3. If `singularity/workflow.yml` is absent, run `init --work-id <WORK-ID> --base <BASE> --fetch`; it keeps protected `main` untouched. Stop for review/publication.
4. Run `workspace branches --json`. Require one branch published by every repository. Never infer or preselect. Stop if unreachable.
5. Use `ask_user` for Jira or manual intake: `title`, audience, `problem`, `desiredOutcome`, scope, stakeholders, urgency, constraints, dependencies, `acceptanceCriteria`, risks, notes, and documents. Keep gaps open. Ask separately for read-only references; each needs a lower-kebab ID, credential-free Git URL, and branch. Explain immutable SHA pinning and no branch/commit/push. Pass paired repeatable `--reference-repository ID=URL --reference-branch ID=BRANCH`; never infer them. Never search the workspace, home directory, filesystem root, or temporary directories for examples. Write story input outside tracked paths; pass `--jira`/`--story-file` and documents.
6. Start a persistent shell with `--from-branch`. At “Choose workflow template,” use `ask_user`, then send the number through `write_bash`. For `poc-workflow`, ask/pass `--target-url`. The phase-default governed agent is automatic. If `ask_user` is unavailable or disabled, stop.
7. Without persistent input run `choices begin start <WORK-ID> --json`; present all choices including base and record via `choices answer <TOKEN>`. Add POC target separately. Use `--selection-receipt <TOKEN>` only when ready; it lasts 15 minutes and successful start consumes the receipt exactly once.
8. Confirm remote base, local/published Story refs, and unchanged base. Report durable files, phase, agent, inputs, next action.
9. Do not generate the artifact unless requested. Offer `/sf-documents upload`, `/sf-nextsteps`, `/sf-next`, `/sf-help`, and `/sf-phase`.

`--jira` uses direct Jira REST through the npm utility and environment credentials. It does not use MCP or an IDE Jira plugin.
