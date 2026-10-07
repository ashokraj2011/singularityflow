---
name: sflow-ready
description: Prove locked packages, installation health, test-framework setup, and existing unit tests before a Story worktree; optionally repair only reviewed dependency/test setup.
disable-model-invocation: true
argument-hint: "[--base-commit <OID>] [--repair] [--full]"

---
# Make a repository ready before Story work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Setup only: Never change product behavior, weaken tests, upgrade versions, install global tools,
record secrets, or edit a Story checkout. Build/start/end-to-end need `--full` and approved policy.

1. Require Git root; without a selected base, require a clean tree. Run `singularity-flow init --check --json`, then `singularity-flow precheck --quick --json`.
   Report test tools, adapters, and launcher availability.
2. Select `dependency-test` unless `--full` is requested. Run
   `singularity-flow precheck --run --scope <SCOPE> --json` once for its plan. Retain any selected
   `--base-commit <OID>` in preview and execution; the CLI owns temporary checkout/cleanup. Show base,
   digest, commands, adapters, timeouts, omissions, runtime flags/advisories, and `planId`.
   For blockers, do not confirm/repeat; use quick precheck and offer a reviewed setup repair.
3. Use `ask_user` to confirm the exact `planId`; otherwise stop with Copilot `/sf-ready` and Shell
   `singularity-flow precheck --run --scope <SCOPE> --confirm-plan <PLAN-ID> --json` (retain base). Execute once.
   Runtime repair needs approved `repositoryReadiness.testRuntime`, not shell-wide `NODE_OPTIONS`.
4. Report receipt or failed baseline: exact base/plan, exit, report hash, failing testcase IDs.
   Missing reports remain unavailable. Never commit local dependency directories, build output,
   test reports, or receipts.
5. Classify setup/existing failures. Use advertised TRP repair admission; required prerequisites remain.
   Otherwise a product failure needs a Bug-fix Story.
   For eligible JUnit/Jest/Vitest/Node TAP baselines, inspect with
   `singularity-flow precheck --risk-status --json`. Only on explicit choice record digest,
   reason, and expiry (at most 30 days) via `singularity-flow precheck --accept-test-risk
   --confirm-baseline <SHA256> --reason <TEXT> --expires <ISO-8601> --json`. Exact-base acceptance
   may allow Story creation, never marks tests passed or waives later publication checks.
6. Without `--repair`, stop. With it, ask before committable setup, create
   `sflow/readiness/<PLAN-DIGEST-PREFIX>`, edit only confirmed paths, and show full diff.
7. After explicit diff approval, rerun and commit only the reviewed paths. Do not push or
   merge unless separately requested. A commit changes the base; obtain a new `planId`,
   confirmation, and receipt.
8. Report the commit/blockers and handoffs: Copilot `/sf-start`; Shell
   `singularity-flow start <WORK-ID>`. A Git refusal retains the setup branch and creates no Story.

TRP: read and follow `singularity-flow explain test-recovery`; returned legal actions only.
