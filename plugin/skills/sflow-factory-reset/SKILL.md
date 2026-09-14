---
name: sflow-factory-reset
description: Preview and deliberately reset repository-owned Singularity Flow configuration and machine-local runtime state from the currently installed npm package defaults.
disable-model-invocation: true
argument-hint: "[--dry-run]"

---
# Factory-reset this repository

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

This operation permanently discards uncommitted files under `singularity/`, the
legacy `.singularity/` and `.sdlc/` directories, and worktree-private plus
repository-shared `.git/.../singularity-flow/` runtime roots. Git history,
application source, workspace clones, the global workspace registry, and custom
repository agents whose filenames are not supplied by Singularity Flow remain.
If one of those custom Agent Markdown files is invalid against the installed
definition, its exact bytes move to the content-addressed, non-active
`.github/singularity-flow-recovered-agents/` recovery root instead of blocking
the reset or being deleted.

1. Run `singularity-flow factory-reset --dry-run --json` first.
2. Show the complete `remove`, `replace`, `preserve`, `uncommittedResetPaths`,
   `uncommittedDiscardPaths`, `customAgentRecoveries`, and `resetScopeSha256`
   values. For every custom-agent recovery show source, destination, digest,
   byte count, and validation reason. Do not summarize away paths.
3. Ask the contributor whether to proceed. The contributor must explicitly
   provide the exact `confirmation` string from the preview.
4. Only after that answer, run:

   ```bash
   singularity-flow factory-reset --confirm "<EXACT CONFIRMATION>" \
     --expect-scope-sha256 "<EXACT resetScopeSha256>" [--allow-dirty] --json
   ```

5. Run `singularity-flow init --check --json` and show `git status --short`.
   Explain that the reset is intentionally uncommitted and must be reviewed.

Pass `--allow-dirty` only when `uncommittedDiscardPaths` was non-empty and the
contributor explicitly selected the data-loss action after seeing those exact
paths. Never apply without the preview's exact `resetScopeSha256`.

Never supply the confirmation yourself, infer consent from the original request,
commit, push, reset Git history, or delete a repository clone. The repository-only
flow must not delete the global workspace registry. If the preview reports
uncommitted reset-scope changes, call them out prominently because factory reset
will discard them.

If the contributor asks to forget registrations but preserve physical workspace
directories, run `sf-reset-all` without `--yes` and show its full preview. If they
ask for a clean machine state that also removes managed workspace directories, use
`/sf-local-reset`; do not substitute the repository-only reset or full reinstall.
