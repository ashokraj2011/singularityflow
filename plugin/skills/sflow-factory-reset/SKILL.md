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
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

This operation permanently discards uncommitted files under `singularity/`, the
legacy `.singularity/` directory, and `.git/singularity-flow/`. Git history,
application source, workspace clones, the global workspace registry, and custom
repository agents whose filenames are not supplied by Singularity Flow remain.

1. Run `singularity-flow factory-reset --dry-run --json` first.
2. Show the complete `remove`, `replace`, `preserve`, and
   `uncommittedResetPaths` lists. Do not summarize away uncommitted paths.
3. Ask the contributor whether to proceed. The contributor must explicitly
   provide the exact `confirmation` string from the preview.
4. Only after that answer, run:

   ```bash
   singularity-flow factory-reset --confirm "<EXACT CONFIRMATION>" --json
   ```

5. Run `singularity-flow init --check --json` and show `git status --short`.
   Explain that the reset is intentionally uncommitted and must be reviewed.

Never supply the confirmation yourself, infer consent from the original request,
commit, push, reset Git history, or delete a repository clone. The repository-only
flow must not delete the global workspace registry. If the preview reports
uncommitted reset-scope changes, call them out prominently because factory reset
will discard them.

If the contributor asks to forget registrations but preserve physical workspace
directories, run `sf-reset-all` without `--yes` and show its full preview. If they
ask for a clean machine state that also removes managed workspace directories, use
`/sf-local-reset`; do not substitute the repository-only reset or full reinstall.
