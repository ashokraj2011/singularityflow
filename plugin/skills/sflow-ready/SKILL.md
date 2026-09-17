---
name: sflow-ready
description: Prove dependencies, build, structured tests, and bounded application startup before a Story worktree is created; repair only reviewed repository setup outside Story work.
disable-model-invocation: true
argument-hint: "[--repair]"

---
# Make a repository ready before Story work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, exact command results, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

This is setup, not feature work. Never change product behavior, weaken tests, install global tools,
run audit-fix/upgrades, record secrets, commit caches/results, or enter a Story worktree.

1. Require the exact Git root and a clean working tree. Run `singularity-flow init --check --json`,
   then `singularity-flow precheck --quick --json`. Repair missing packaged SFlow assets through
   `/sf-init`; do not overwrite custom configuration.
2. Run `singularity-flow precheck --run --json` once. This is a plan only. Show its exact base
   revision, manifest/lock digest, shell-free dependency/build/test/start commands, structured test
   adapter, timeouts, omissions, and `planId`. Do not execute the plan yet.
3. Use `ask_user` to confirm that exact `planId`. If interactive choice is unavailable, stop and
   show both routes: Copilot `/sf-ready`; Shell
   `singularity-flow precheck --run --confirm-plan <PLAN-ID> --json`.
4. Execute once. Report each outcome, adapter/probe assurance, and Git-private receipt.
5. A passing run changes no tracked repository path. Continue to `/sf-start`. Never commit local
   dependency directories, virtual environments, build products, test reports, or the readiness
   receipt.
6. On failure, classify it before changing anything:
   - **local-only:** missing locked dependencies or disposable cache; rerun the exact frozen restore;
   - **committable setup:** manifest script, lockfile, wrapper executable bit, test-runner/reporter
     configuration, or explicit startup probe metadata;
   - **product/test behavior:** source/assertion failure or ambiguous framework/version/port. Stop.
7. For committable setup, show paths and use `ask_user`. Create
   `sflow/readiness/<PLAN-DIGEST-PREFIX>`, edit only confirmed paths, and show the complete diff.
8. After explicit diff approval, rerun the readiness plan. If it passes, commit only the reviewed
   paths with a repository-readiness message. Do not push or merge unless separately requested.
   The commit changes the base: rerun `singularity-flow precheck --run`, confirm its new `planId`,
   and record the final receipt.
9. Report the exact commit, remaining blockers, and both handoffs: Copilot `/sf-start`; Shell
   `singularity-flow start <WORK-ID>`. A protected-base or push-rule refusal retains the setup
   branch and must never create a Story.
