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

1. Require a work ID and opened Git root, else use the verified `repositoryPath`. Run `singularity-flow version` and `git status --short`; stop on failure or dirt.
2. Run `singularity-flow session candidates --json`. If the ID exists, route to `/sf-session` or `singularity-flow resume <WORK-ID>`; never restart it.
3. Run `singularity-flow workspace branches --json --intake`. With approved remote configuration, a code-only application branch is valid. On authority failure show Shell `singularity-flow workspace reinitialize --dry-run --json` and Copilot `/sf-admin`; never run `init` merely because `singularity/workflow.yml` is absent locally.
4. Never infer or preselect. Choose one base and one workflow: choose `<BASE>`; run `singularity-flow workspace branches --json --intake --preflight-story <WORK-ID> --from-branch <BASE>` without `--work-type`; choose `<WORKFLOW>` only from its exact-base `intake.storyWorkflows`.
5. With `ask_user`, collect Jira or manual `desiredOutcome`, `acceptanceCriteria`, scope, risks, and documents. A read-only reference needs ID, credential-free URL, and branch; pair `--reference-repository ID=URL --reference-branch ID=BRANCH`. Never search the workspace, home directory, filesystem root, or temporary directories. Pass `--jira`/`--story-file` and documents.
6. Run `singularity-flow workspace branches --json --intake --preflight-story <WORK-ID> --from-branch <BASE> --work-type <WORKFLOW>`. World Model, AST, model-provider, telemetry, and Copilot availability are advisory. On missing/stale repository readiness, stop before worktree creation and show `/sf-ready` plus `singularity-flow precheck --run --json`. Never apply a persistent configuration upgrade from this skill.
7. Start with the same base/workflow; never ask for, infer, or accept a second workflow choice. Start recomputes the same readiness immediately before mutation. `poc-workflow` needs `--target-url`; the phase-default governed agent is automatic. If `ask_user` is unavailable or disabled, use step 8 or stop.
8. Without `ask_user`, require pinned configuration. Run `singularity-flow choices begin start <WORK-ID> --json`, then `singularity-flow choices answer <TOKEN>` and pass `--selection-receipt <TOKEN>`; it lasts 15 minutes and the command consumes the receipt exactly once.
9. Report readiness, exact base, receipt, and next action. Enrollment occurs only after the read-only publication preflight succeeds. Offer `/sf-next` and `/sf-phase`.
