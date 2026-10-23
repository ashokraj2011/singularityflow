---
name: sflow-ready
description: Prove locked packages, installation health, test-framework setup, and existing unit tests before a Story worktree; optionally repair only reviewed dependency/test setup.
disable-model-invocation: true
argument-hint: "[--base-commit <OID>] [--repair] [--full]"

---
# Make a repository ready before Story work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Setup only: Never change product behavior, weaken tests, upgrade versions, install global tools
(name missing ones for the person; rerun `/sf-ready`), record secrets, or edit a Story checkout. Build/start/end-to-end need `--full` and approved policy.

1. Require Git root; without a selected base, require a clean tree (else
   `--base-commit <OID>` or the person's commit/stash). Run `singularity-flow init --check --json`, then `singularity-flow precheck --quick --json`.
   Report test tools, adapters and launchers.
2. Select `dependency-test` unless `--full` is requested. Run
   `singularity-flow precheck --run --scope <SCOPE> --json` once for its plan. Retain any
   `--base-commit <OID>` in preview/execution; the CLI owns its temporary checkout. Show base,
   digest, commands, adapters, timeouts, omissions, runtime flags/advisories, `planId`.
   Blockers: never confirm/repeat; use quick precheck and offer a reviewed setup repair.
3. Use `ask_user` to confirm the exact `planId`; otherwise stop with Copilot `/sf-ready` and Shell
   `singularity-flow precheck --run --scope <SCOPE> --confirm-plan <PLAN-ID> --json` (retain base). Execute once.
   Runtime repair needs approved `repositoryReadiness.testRuntime`, never shell-wide `NODE_OPTIONS`/`JAVA_TOOL_OPTIONS`/`PYTHONPATH`.
4. Report receipt or failed baseline: exact base/plan, exit, report hash, failing test IDs.
   Missing reports stay unavailable. Never commit local dependency directories, build output,
   test reports, or receipts.
5. Classify setup/existing failures. Use advertised TRP repair admission; required prerequisites remain.
   Failed tests never block Story start: repair in scope or record risk; a Bug-fix Story is optional.
   For `junit-xml` (any runner), `jest-json`, `vitest-json` or `node-tap` baselines (else switch reporter:
   `/sf-test-setup`), inspect with
   `singularity-flow precheck --risk-status --json`. On explicit choice only, record digest,
   reason and expiry (max 30 days) via `singularity-flow precheck --accept-test-risk
   --confirm-baseline <SHA256> --reason <TEXT> --expires <ISO-8601> --json`. Acceptance never
   marks tests passed or waives publication checks.
6. Without `--repair`, stop. With it, ask before committable setup and name the exact paths and changes.
   No turn before a Story edits files or runs Git (edits bind to a step's policy), so the person creates
   `sflow/readiness/<PLAN-DIGEST-PREFIX>`, edits only confirmed paths and shows the full diff in their own terminal.
7. After explicit diff approval they commit only the reviewed paths. Do not push or
   merge unless separately requested. A commit changes the base; rerun `/sf-ready` for a new `planId`,
   confirmation and receipt.
8. Report commit/blockers and handoffs: Copilot `/sf-start`; Shell
   `singularity-flow start <WORK-ID>`. A Git refusal retains the setup branch and creates no Story.

TRP: read and follow `singularity-flow explain test-recovery`; returned legal actions only.
