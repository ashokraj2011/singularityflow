---
name: sflow-init
description: Verify and safely repair Singularity Flow initialization assets on the current or explicitly selected Work-ID branch without overwriting repository customizations.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--base BRANCH] [--fetch]"

---
# Verify or repair branch initialization

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

This is a setup-only action. Do not implement product work, generate phase
artifacts, submit, approve, reset, stash, force-push, or edit repository
customizations.

1. Always run `singularity-flow init --check --json` first. Display the current
   branch, whether initialization is complete, missing files, and any
   configuration validation error.
2. When a Work ID was explicitly supplied, validate that it contains only
   letters, numbers, `.`, `_`, or `-`. If the reported current branch already
   equals that Work ID, repair it in place with `singularity-flow init
   --repair`. Otherwise require a clean working tree and run
   `singularity-flow init --repair --work-id <WORK-ID> --base <BASE> --fetch`
   to create, reuse, or fast-forward that branch before repairing it. Use
   `main` only as the default base for a branch that does not exist; never
   modify the base branch.
3. When no Work ID was supplied and the check reports missing assets, run
   `singularity-flow init --repair` on the current branch.
4. Repair is additive: it restores missing workflow, portfolio, template,
   agent, and prompt files from the installed package. It must never replace
   an existing customized file. If an existing file is invalid, report the
   validation error and recommend restoring that exact file from Git history;
   do not overwrite it.
5. Rerun `singularity-flow init --check --json`, then run
   `singularity-flow doctor --offline --json`. Report every remaining failure
   and warning with its exact fix.
6. Show `git status --short` and list the files added by repair. Do not commit
   or push initialization changes automatically; the contributor must review
   them first.

If the initial check is complete, make no changes and say that the branch is
already initialized.
