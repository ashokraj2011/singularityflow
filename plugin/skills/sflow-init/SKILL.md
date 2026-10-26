---
name: sflow-init
description: Create deterministic smart initialization for a fresh repository, or verify and safely repair existing Singularity Flow assets without overwriting repository customizations.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--base BRANCH] [--fetch]"

---
# Verify or repair branch initialization

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Setup only: do not implement, submit, approve, reset, stash, force-push, or edit customizations.

For explicitly requested smart or zero-manual initialization, require a fresh repository:

1. Run `singularity-flow init --smart-detect --dry-run --json` once. Show stacks, commands, gaps,
   suggestions, write set, and proposal SHA-256. Never run a detected command.
2. Ask explicitly about unresolved candidates and optional protections. Never infer ambiguity or
   select unchecked suggestions.
3. Show `--accept-proposal <file> --confirm <sha256>`; use `--yes` only after explicit acceptance.
4. Activate only after exact confirmation. Preserve the receipt, commit, readiness, and next
   command. Proposal-only and review-proposal files are not active law.
5. Run metadata-only `singularity-flow precheck --quick --json`. Offer Copilot `/sf-ready` and
   Shell `singularity-flow precheck --run --scope dependency-test --json`. Only the readiness flow
   (`/sf-ready` or its shown Shell equivalent)—not init—executes the confirmed repository plan.

On `INI_RECOVERY_REQUIRED`, run only its exact
`singularity-flow init --recover --proposal <SHA256> --json`; never edit its journal.

For ordinary `init`, `--check`, or `--repair`:

1. Run `singularity-flow init --check --json` first. Show branch, completeness, missing files, and
   validation errors.
2. Validate a supplied Work ID as letters, numbers, `.`, `_`, or `-`. If `setup/<WORK-ID>` is current, use
   `singularity-flow init --repair`. Otherwise require a clean tree and run
   `singularity-flow init --repair --work-id <WORK-ID> [--base <BASE>] --fetch` (`--base` only when the person named one;
   omitted, it is the remote default, never an assumed `main`). It creates, reuses or fast-forwards the setup branch.
   Never initialize the Story branch; leave it for `singularity-flow start <WORK-ID> --from-branch setup/<WORK-ID>`
   after setup is committed and published. Never modify base.
3. When no Work ID was supplied and the check reports missing assets, run
   `singularity-flow init --repair` on the current branch.
4. Restore only missing packaged files; never replace customization. Restore invalid files from Git.
5. Rerun `singularity-flow init --check --json`, then run
   `singularity-flow doctor --offline --json`. Report every remaining failure
   and warning with its exact fix.
6. Show the files the repair reported. Do not commit or push repair automatically; after review,
   offer `/sf-configuration publish` to commit and push the setup branch.
7. Before the first Story, offer `/sf-ready` and
   `singularity-flow precheck --run --scope dependency-test --json`.

If the initial check is complete, change nothing and say the branch is initialized.
