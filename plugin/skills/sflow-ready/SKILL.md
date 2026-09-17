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

This is setup, not feature work. Never change product behavior, weaken tests, edit assertions,
snapshots, or fixtures, skip tests, lower thresholds, upgrade versions, install global tools, record
secrets, or enter a Story worktree. Build, quality, application-start, watch, and end-to-end commands
are forbidden unless `$ARGUMENTS` contains `--full`; use full only for approved policy requiring it.

1. Require the exact Git root and clean tree. Run `singularity-flow init --check --json`, then
   `singularity-flow precheck --quick --json`. Use `/sf-init` for missing packaged assets; preserve
   customization.
2. Select `dependency-test` unless `$ARGUMENTS` contains `--full`. Run
   `singularity-flow precheck --run --scope <SCOPE> --json` once; it is a plan only. Show the exact
   base, manifest/lock digest, locked dependencies, existing unit commands, structured adapter,
   timeouts, omissions, scope, and `planId`. Narrow scope rejects build, quality, start, watch,
   end-to-end, and newly authored tests.
3. Use `ask_user` to confirm the exact `planId`; otherwise stop with Copilot `/sf-ready` and Shell
   `singularity-flow precheck --run --scope <SCOPE> --confirm-plan <PLAN-ID> --json`. Execute once.
4. Report each result and the Git-private receipt. A pass changes no tracked path. Never commit local
   dependency directories, virtual environments, build output, test reports, or the receipt.
5. Classify failure: **local-only** missing packages/cache permits the exact frozen restore;
   **committable setup** permits only manifest script, lockfile, wrapper bit, runner/reporter, or
   non-watch/headless unit configuration; **existing unit failure** is reported with counts and
   offered as a separate Bug-fix Story, never repaired here.
6. Without `--repair`, stop. With it, ask before committable setup, create
   `sflow/readiness/<PLAN-DIGEST-PREFIX>`, edit only confirmed paths, and show the full diff.
7. After explicit diff approval, rerun readiness and commit only the reviewed paths. Do not push or
   merge unless separately requested. The commit changes the base: rerun the scoped plan, confirm
   its new `planId`, and record the final receipt.
8. Report the commit/blockers and handoffs: Copilot `/sf-start`; Shell
   `singularity-flow start <WORK-ID>`. A Git refusal retains the setup branch and creates no Story.
