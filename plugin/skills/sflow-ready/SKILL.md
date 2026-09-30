---
name: sflow-ready
description: Prove locked packages, installation health, test-framework setup, and existing unit tests before a Story worktree; optionally repair only reviewed dependency/test setup.
disable-model-invocation: true
argument-hint: "[--repair] [--full]"

---
# Make a repository ready before Story work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Require explicit choices; preserve errors, exact results, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Setup only: Never change product behavior, weaken tests, skip checks, upgrade versions, install
global tools, record secrets, or enter a Story worktree. Build, quality, application-start,
end-to-end are forbidden unless `--full` and approved policy permit them.

1. Require exact Git root/clean tree. Run `singularity-flow init --check --json`, then `singularity-flow precheck --quick --json`.
   Report `testTools`, adapter, launcher availability. Missing runner is setup; `/sf-init` repairs
   packaged assets without erasing customization.
2. Select `dependency-test` unless `--full` is requested. Run `singularity-flow precheck --run --scope <SCOPE> --json` once for its plan only. Show base, manifest digest, locked dependencies or frozen restore,
   test commands, structured test adapter, timeouts, omissions, scope, `planId`. Narrow scope
   excludes build/start/end-to-end.
3. Use `ask_user` to confirm the exact `planId`; otherwise stop with Copilot `/sf-ready` and Shell
   `singularity-flow precheck --run --scope <SCOPE> --confirm-plan <PLAN-ID> --json`. Execute once.
4. Report results/Git-private receipt. On failure report separate baseline/hash: exact base/plan,
   exit, report digest, testcase IDs. Missing reports stay unavailable. Never commit local
   dependency directories, build output, test reports, or receipts.
5. Classify: **local-only** package/cache restore; **committable setup** manifest/lock/wrapper,
   runner/reporter, or headless unit config; **existing test failure** exact baseline and repair
   before feature coding. An existing unit failure needs a separate Bug-fix Story if not setup;
   never mask it. For an unchanged JUnit/Jest/Vitest baseline, offer
   read-only `singularity-flow precheck --risk-status --json`. If the user explicitly chooses a
   local acknowledgement, require exact baseline digest, reason, expiry (within 30 days)
   with `singularity-flow precheck --accept-test-risk --confirm-baseline <SHA256> --reason <TEXT>
   --expires <ISO-8601> --json`. This Git-private record is not authenticated approval and changes
   no Story-start/publication gate. Failed is not passed; never silently skip tests or claim this
   unblocks a workflow.
6. Without `--repair`, stop. With it, ask before committable setup, create
   `sflow/readiness/<PLAN-DIGEST-PREFIX>`, edit only confirmed paths, and show full diff.
7. After explicit diff approval, rerun and commit only the reviewed paths. Do not push or
   merge unless separately requested. A commit changes the base, so obtain a new `planId`,
   confirmation, and receipt before relying on readiness again.
8. Report the commit/blockers and handoffs: Copilot `/sf-start`; Shell
   `singularity-flow start <WORK-ID>`. A Git refusal retains the setup branch and creates no Story.
