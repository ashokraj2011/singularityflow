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

Setup only: never change product behavior, weaken tests, skip checks, upgrade versions, install
global tools, record secrets, or enter a Story worktree. Build/start/end-to-end commands require
`--full` and an approved policy.

1. Require exact Git root and clean tree. Run `singularity-flow init --check --json`, then `singularity-flow precheck --quick --json`.
   Report discovered `testTools`, adapter, and launcher availability. Missing runner is a setup
   finding; use `/sf-init` for packaged assets without erasing customization.
2. Select `dependency-test` unless `--full` is requested. Run `singularity-flow precheck --run --scope <SCOPE> --json` once for its plan. Show base, manifest digest, dependencies, test commands/adapter,
   timeouts, omissions, scope, and `planId`. Narrow scope excludes build/start/end-to-end.
3. Use `ask_user` to confirm the exact `planId`; otherwise stop with Copilot `/sf-ready` and Shell
   `singularity-flow precheck --run --scope <SCOPE> --confirm-plan <PLAN-ID> --json`. Execute once.
4. Report results and Git-private receipt. On failure, report the separate baseline and hash:
   exact base/plan, exit, report digest, and available testcase identities. Missing reports stay
   unavailable. Never commit dependency directories, build output, reports, or local receipts.
5. Classify: **local-only** package/cache restore; **committable setup** manifest/lock/wrapper,
   runner/reporter, or headless unit config; **existing test failure** exact baseline and repair
   before feature coding. For a complete unchanged JUnit/Jest/Vitest baseline, show the optional
   read-only `singularity-flow precheck --risk-status --json`. If the user explicitly chooses a
   local acknowledgement, require its exact baseline digest, reason, and expiry (within 30 days)
   with `singularity-flow precheck --accept-test-risk --confirm-baseline <SHA256> --reason <TEXT>
   --expires <ISO-8601> --json`. This Git-private record is not authenticated approval and changes
   no Story-start or publication gate. A failed baseline is not a passing receipt; never silently
   skip tests or claim the acknowledgement unblocks a workflow.
6. Without `--repair`, stop. With it, ask before committable setup, create
   `sflow/readiness/<PLAN-DIGEST-PREFIX>`, edit only confirmed paths, and show the full diff.
7. After diff approval, rerun and commit only reviewed paths. Do not push/merge without request.
   The new base needs a new scoped plan, confirmation, and receipt.
8. Report the commit/blockers and handoffs: Copilot `/sf-start`; Shell
   `singularity-flow start <WORK-ID>`. A Git refusal retains the setup branch and creates no Story.
