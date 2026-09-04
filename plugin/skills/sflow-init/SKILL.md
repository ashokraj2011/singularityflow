---
name: sflow-init
description: Create deterministic smart initialization for a fresh repository, or verify and safely repair existing Singularity Flow assets without overwriting repository customizations.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--base BRANCH] [--fetch]"

---
# Verify or repair branch initialization

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Setup only: do not implement, submit, approve, reset, stash, force-push, or edit customizations.

When the user explicitly requests smart, automatic, or zero-manual-configuration initialization,
the repository must be fresh and the flow is proposal-first:

1. Run `singularity-flow init --smart-detect --dry-run --json` once. Show stacks, commands, gaps,
   suggestions, write set, and proposal SHA-256. Never run a detected command.
2. Ask explicitly about unresolved candidates and optional protections. Never infer ambiguity or
   select unchecked suggestions.
3. Show `--accept-proposal <repository-file> --confirm <proposal-sha256>`, or `--yes` only when the
   user explicitly accepts all visible defaults.
4. Activate only after exact confirmation. Preserve the receipt, commit, readiness, and next
   command. Proposal-only and review-proposal files are not active law.
5. Run `singularity-flow precheck --quick --json`; never substitute tests, builds, scripts, or models.

If the CLI reports `INI_RECOVERY_REQUIRED`, run only its exact
`singularity-flow init --recover --proposal <SHA256> --json` command. Report whether it proved the
activation commit complete or rolled back exact unchanged managed bytes. Never delete or edit a
recovery journal by hand.

For ordinary `init`, `--check`, or `--repair`, continue with the compatible workflow below.

1. Run `singularity-flow init --check --json` first. Show branch, completeness, missing files, and
   validation errors.
2. When a Work ID was explicitly supplied, validate that it contains only
   letters, numbers, `.`, `_`, or `-`. If the current branch equals that Work ID, use
   `singularity-flow init --repair`. Otherwise require a clean tree and run
   `singularity-flow init --repair --work-id <WORK-ID> --base <BASE> --fetch`
   to create, reuse, or fast-forward it. Default to `main` only for a new branch; never modify base.
3. When no Work ID was supplied and the check reports missing assets, run
   `singularity-flow init --repair` on the current branch.
4. Repair only restores missing packaged files. Never replace customization. For invalid existing
   files, report the error and recommend restoring that file from Git history.
5. Rerun `singularity-flow init --check --json`, then run
   `singularity-flow doctor --offline --json`. Report every remaining failure
   and warning with its exact fix.
6. Show `git status --short` and added files. Do not commit or push repair automatically.

If the initial check is complete, make no changes and say that the branch is
already initialized.
