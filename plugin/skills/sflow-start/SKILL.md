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

1. Require a work ID. Read `singularity-flow workspace current --json`. If its selected repository is planned (`missing` or `empty`), run `singularity-flow workspace repair <WORKSPACE-PATH> --repository <REPOSITORY-ID> --level readiness --json` at this Start Work boundary. Re-read the selection; use only a ready `repositoryPath`, else the opened Git root. Run `singularity-flow version` and `git status --short`; stop on failure or dirt.
2. Run `singularity-flow session candidates --json`. If the ID exists, route to `/sf-session` or `singularity-flow resume <WORK-ID>`; never restart it.
3. Run `singularity-flow workspace branches --json --intake`. Its `repositories` are required. Check `singularity-flow workspace status <WORKSPACE-PATH> --level readiness --json`; repair each required `missing`/`empty` member with `singularity-flow workspace repair <WORKSPACE-PATH> --repository <REPOSITORY-ID> --level readiness --json` before preflight. Leave others planned. On authority failure show Shell `singularity-flow workspace reinitialize --dry-run --json` and Copilot `/sf-admin`; never run `init` for an absent local workflow file.
4. Never preselect. Choose `<BASE>`; run `singularity-flow workspace branches --json --intake --preflight-story <WORK-ID> --from-branch <BASE>` without `--work-type`. Choose `<WORKFLOW>` from its exact-base `intake.storyWorkflows`.
5. With `ask_user`, collect Jira or manual `desiredOutcome`, `acceptanceCriteria`, scope, risks, and documents. A read-only reference needs ID, credential-free URL, and branch; pair `--reference-repository ID=URL --reference-branch ID=BRANCH`. Never search the workspace, home directory, filesystem root, or temporary directories. Pass `--jira`/`--story-file` and documents.
6. Run `singularity-flow workspace branches --json --intake --preflight-story <WORK-ID> --from-branch <BASE> --work-type <WORKFLOW>`. World Model, AST, model, telemetry, and Copilot availability are advisory. On missing/stale readiness, stop and show `/sf-ready` plus `singularity-flow precheck --run --scope dependency-test --json`. Never apply a persistent configuration upgrade here.
7. Start with the same base/workflow; never change the workflow choice. Start recomputes readiness before mutation. `poc-workflow` needs `--target-url`; the phase-default agent is automatic. If `ask_user` is unavailable, use step 8 or stop.
8. Without `ask_user`, require pinned configuration: `singularity-flow choices begin start <WORK-ID> --json`, `singularity-flow choices answer <TOKEN>`, then pass `--selection-receipt <TOKEN>` (15-minute, single-use).
9. Report readiness, base, receipt, and next action. Enroll only after preflight passes. Offer `/sf-next` and `/sf-phase`.
